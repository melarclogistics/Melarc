import { CliUsageError } from './cli.js';
import type { SqlClient } from './provisioning.js';

/**
 * The upgrade check of migration 0064 (S1.21; OB-S1-35, the Product Owner's decision of 2 November 2026): does the mark of a rider commitment on
 * each pickup request agree with the request's current claim?
 *
 * **A request is committed to a rider while a stop with no `released_at` holds it on a manifest that has a rider**, and at no other time. Before
 * migration 0064 the mark (`pickup_request.rider_assigned`) was raised by the assignment of a rider and never lowered, so a request returned to
 * the pool by the cancellation of its manifest kept it. The migration changes what the database enforces and **repairs nothing**.
 *
 * **Why this is a command and not part of the migration.** The migration runs as `melarc_migration_elevated`, which reads these tables
 * through forced row-level security like any other login, and so would find no request: a check made there would pass because it could not see,
 * which is the very mistake the mark exists to avoid. The cluster administrator's login can see every row, so the check is made with it, by
 * hand, before a persistent database is migrated, and its result is recorded.
 *
 * - **Checking changes nothing.** It reports the confirmed requests that are marked and held by no manifest that has a rider (stale), the
 *   ones that are held and not marked (missing), and how many requests that are not confirmed carry the mark (a cancelled request is frozen
 *   with the mark and the charge decision its cancellation was made on, and is never reconciled).
 * - **Reconciling puts right only a confirmed request that disagrees with its current claim**, in both directions, in one transaction, with the
 *   three tables locked against writers while it runs, and checks the result before it commits. It changes nothing but the mark (and the version
 *   the database moves with it); a charge decision, a snapshot and a cancelled request are untouched.
 *
 * It needs a login that bypasses row-level security (the administrator's), and the application and the worker should be stopped while it runs.
 */
export const COMMITMENT_MARKS_USAGE =
  'usage: node dist/tools/db-commitment-marks.js [database] [--reconcile]   (default database: melarc_dev; without --reconcile it changes nothing)';

export interface CommitmentMarkArguments {
  readonly database: string;
  readonly reconcile: boolean;
}

/** The database (default `melarc_dev`) and the one flag that changes data. */
export function parseCommitmentMarkArguments(argv: readonly string[]): CommitmentMarkArguments {
  let reconcile = false;
  const databases: string[] = [];
  for (const argument of argv) {
    if (argument === '--reconcile') reconcile = true;
    else if (argument.startsWith('-')) {
      throw new CliUsageError(`unknown option ${argument.slice(0, 40)}. ${COMMITMENT_MARKS_USAGE}`);
    } else databases.push(argument);
  }
  if (databases.length > 1) {
    throw new CliUsageError(`one database at a time. ${COMMITMENT_MARKS_USAGE}`);
  }
  return { database: databases[0] ?? 'melarc_dev', reconcile };
}

export interface MarkedRequest {
  readonly id: string;
  readonly code: string;
}

export interface CommitmentMarkReport {
  /** The database's clock when the check was made, for the record. */
  readonly checkedAt: string;
  /** Whether there is a `pickup_request` table at all (migration 0045). */
  readonly requestsTable: boolean;
  /** Whether the manifest tables exist (migration 0058): without them no request can be held, and any mark on a confirmed request is stale. */
  readonly claimTables: boolean;
  readonly confirmed: number;
  /** Marked, and held by no stop that has not released its claim on a manifest that has a rider. */
  readonly stale: readonly MarkedRequest[];
  /** Held by a stop that has not released its claim on a manifest that has a rider, and not marked. */
  readonly missing: readonly MarkedRequest[];
  /** Requests that are not confirmed and carry the mark: history, left as it is. */
  readonly keptMarked: number;
}

export const isConsistent = (report: CommitmentMarkReport): boolean =>
  report.stale.length === 0 && report.missing.length === 0;

/** Whether a request is held now, for the alias of a request table in the statement it is put into (a constant of this file, never input). */
const heldBy = (alias: string): string =>
  `exists (select 1 from public.pickup_stop s join public.pickup_manifest m on m.id = s.pickup_manifest_id
            where s.pickup_request_id = ${alias}.id and s.released_at is null and m.assigned_rider_id is not null)`;

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Looks at every confirmed request and says which disagree with their claims. Changes nothing. */
export async function checkCommitmentMarks(client: SqlClient): Promise<CommitmentMarkReport> {
  const probe = await client.query(
    `select to_regclass('public.pickup_request') is not null as requests,
            (to_regclass('public.pickup_stop') is not null and to_regclass('public.pickup_manifest') is not null) as claims,
            to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS "UTC"') as at`,
  );
  const found = probe.rows[0] ?? {};
  const requestsTable = found.requests === true;
  const claimTables = found.claims === true;
  const checkedAt = textOf(found.at);
  if (!requestsTable) {
    return {
      checkedAt,
      requestsTable,
      claimTables: false,
      confirmed: 0,
      stale: [],
      missing: [],
      keptMarked: 0,
    };
  }

  const confirmed = await client.query(
    `select r.id, r.code, r.rider_assigned as marked, ${claimTables ? heldBy('r') : 'false'} as committed
       from public.pickup_request r
      where r.state = 'CONFIRMED'
      order by r.code, r.id`,
  );
  const stale: MarkedRequest[] = [];
  const missing: MarkedRequest[] = [];
  for (const row of confirmed.rows) {
    const request = { id: textOf(row.id), code: textOf(row.code) };
    if (row.marked === true && row.committed !== true) stale.push(request);
    if (row.marked !== true && row.committed === true) missing.push(request);
  }
  const frozen = await client.query(
    `select count(*)::int as n from public.pickup_request where state <> 'CONFIRMED' and rider_assigned`,
  );
  return {
    checkedAt,
    requestsTable,
    claimTables,
    confirmed: confirmed.rows.length,
    stale,
    missing,
    keptMarked: Number(frozen.rows[0]?.n ?? 0),
  };
}

export interface Reconciled {
  readonly lowered: readonly MarkedRequest[];
  readonly raised: readonly MarkedRequest[];
}

/**
 * Sets the mark of each confirmed request that disagrees with its claim to what its claim says, and returns what it lowered and what it raised.
 * **The caller owns the transaction and the locks** (`runCommitmentMarks` takes them): a statement judged on a snapshot must not meet a
 * writer that changes the claim or the mark between the snapshot and the row.
 */
export async function reconcileCommitmentMarks(
  client: SqlClient,
  claimTables: boolean,
): Promise<Reconciled> {
  const changed = await client.query(
    `update public.pickup_request r set rider_assigned = c.committed
       from (select q.id, ${claimTables ? heldBy('q') : 'false'} as committed
               from public.pickup_request q where q.state = 'CONFIRMED') c
      where r.id = c.id and r.state = 'CONFIRMED' and r.rider_assigned is distinct from c.committed
      returning r.id, r.code, c.committed`,
  );
  const lowered: MarkedRequest[] = [];
  const raised: MarkedRequest[] = [];
  for (const row of changed.rows) {
    (row.committed === true ? raised : lowered).push({
      id: textOf(row.id),
      code: textOf(row.code),
    });
  }
  return { lowered, raised };
}

export interface CommitmentMarkRun {
  readonly before: CommitmentMarkReport;
  /** Present when the command reconciled something. */
  readonly reconciled?: Reconciled;
  readonly after?: CommitmentMarkReport;
  /** Whether the database agrees with its claims now: what the command's exit code says. */
  readonly consistent: boolean;
}

/**
 * Checks, and with `reconcile` puts right what disagrees, in one transaction that locks the pickup tables against writers, checks the result
 * before it commits and rolls everything back if it is not consistent. A consistent database is not touched, with or without the flag.
 */
export async function runCommitmentMarks(
  client: SqlClient,
  options: { readonly reconcile: boolean },
): Promise<CommitmentMarkRun> {
  const before = await checkCommitmentMarks(client);
  if (!options.reconcile || isConsistent(before))
    return { before, consistent: isConsistent(before) };

  await client.query('begin');
  try {
    await client.query("set local lock_timeout = '10s'");
    await client.query(
      `lock table ${
        before.claimTables
          ? 'public.pickup_request, public.pickup_stop, public.pickup_manifest'
          : 'public.pickup_request'
      } in share row exclusive mode`,
    );
    const reconciled = await reconcileCommitmentMarks(client, before.claimTables);
    const after = await checkCommitmentMarks(client);
    if (!isConsistent(after)) {
      throw new Error(
        'the reconciliation did not leave the marks consistent with the claims, so nothing was changed',
      );
    }
    await client.query('commit');
    return { before, reconciled, after, consistent: true };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

const listOf = (requests: readonly MarkedRequest[]): string =>
  requests.map((request) => `    ${request.code}  ${request.id}`).join('\n');

/** What the command prints: what was looked at, what disagrees, what was changed, and the result to record. */
export function formatCommitmentReport(
  database: string,
  report: CommitmentMarkReport,
  reconciled?: Reconciled,
): string {
  const lines = [`commitment marks of ${database}, checked ${report.checkedAt}`];
  if (!report.requestsTable) {
    lines.push('  no pickup_request table: nothing to check', 'result: consistent');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`  looked at ${String(report.confirmed)} confirmed requests`);
  if (!report.claimTables) {
    lines.push(
      '  no manifest tables yet (migration 0058 is not applied): no manifest can hold a request, so a mark on a confirmed request is stale',
    );
  }
  lines.push(
    `  stale marks (marked, held by no manifest that has a rider): ${String(report.stale.length)}`,
  );
  if (report.stale.length > 0) lines.push(listOf(report.stale));
  lines.push(
    `  missing marks (held by a manifest that has a rider, not marked): ${String(report.missing.length)}`,
  );
  if (report.missing.length > 0) lines.push(listOf(report.missing));
  lines.push(
    `  ${String(report.keptMarked)} requests that are not confirmed carry the mark: a cancelled request keeps the mark and the charge decision it was cancelled on, and is never changed`,
  );
  if (reconciled !== undefined) {
    lines.push(
      `reconciled: lowered ${String(reconciled.lowered.length)}, raised ${String(reconciled.raised.length)}`,
    );
    if (reconciled.lowered.length > 0) lines.push('  lowered:', listOf(reconciled.lowered));
    if (reconciled.raised.length > 0) lines.push('  raised:', listOf(reconciled.raised));
    lines.push('result: consistent after reconciling');
  } else if (report.stale.length === 0 && report.missing.length === 0) {
    lines.push('result: consistent');
  } else {
    lines.push(
      'result: NOT consistent. Stop the application and the worker, then run it again with --reconcile to put right the confirmed requests above; nothing was changed by this check.',
    );
  }
  return `${lines.join('\n')}\n`;
}
