import { CliUsageError } from './cli.js';
import type { SqlClient } from './provisioning.js';

/**
 * The upgrade check of migration 0065 (S1.22; the Product Owner's decision of 2 November 2026: run the documented preflight with sufficient
 * visibility, and stop the migration if it finds a violation): does a **cancelled** pickup request still hold a stop that is **still to be worked**?
 *
 * Migration 0065 adds a constraint, checked at the end of a transaction, that a cancelled request and a stop that holds it (its claim not released)
 * and is `PENDING` or `ARRIVED` never coexist. It checks what a transaction writes, not what is already there, and it repairs nothing. A database
 * built by the migrations holds no such pair, because the cancellation of a request has skipped its stop in its own transaction since migration 0059;
 * a pair made some other way would be found by the first update of either row, which the constraint would refuse, so the way to find it first is to
 * look.
 *
 * **Why this is a command and not part of the migration, and why it needs the administrator's login.** The migration login and the runtime login
 * read these tables through forced row-level security like any other login, and the policies show a login with no hub scope no row: a check made
 * there answers "nothing" because it could not see, which is the mistake this exists to avoid. The cluster administrator's login sees every row.
 *
 * It only reads. It has no flag that writes, because what to do with a pair it finds is the Product Owner's decision and not a default: the rule's
 * own answer is the stop skipped with the system's reason `REQUEST_CANCELLED`, as the cancellation of a request has done since 0059, but a pair that
 * exists was made outside the application and says something is wrong that is worth understanding first.
 */
export const OPEN_STOP_CHECK_USAGE =
  'usage: node dist/tools/db-open-stops.js [database]   (default database: melarc_dev; it only reads)';

export interface OpenStopArguments {
  readonly database: string;
}

/** The database (default `melarc_dev`). There is no flag: the check changes nothing. */
export function parseOpenStopArguments(argv: readonly string[]): OpenStopArguments {
  const databases: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith('-')) {
      throw new CliUsageError(`unknown option ${argument.slice(0, 40)}. ${OPEN_STOP_CHECK_USAGE}`);
    }
    databases.push(argument);
  }
  if (databases.length > 1) {
    throw new CliUsageError(`one database at a time. ${OPEN_STOP_CHECK_USAGE}`);
  }
  return { database: databases[0] ?? 'melarc_dev' };
}

export interface OpenStop {
  readonly requestId: string;
  readonly requestCode: string;
  readonly stopId: string;
  readonly stopState: string;
  readonly manifestId: string;
  readonly manifestCode: string;
}

export interface OpenStopReport {
  /** The database's clock when the check was made, for the record. */
  readonly checkedAt: string;
  /** Whether the request, manifest and stop tables exist (migrations 0045 and 0058): without them no request can be held by a stop. */
  readonly tables: boolean;
  readonly open: readonly OpenStop[];
}

export const isClear = (report: OpenStopReport): boolean => report.open.length === 0;

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Looks at every cancelled request and says which still hold a stop that is to be worked. Changes nothing. */
export async function checkOpenStops(client: SqlClient): Promise<OpenStopReport> {
  const probe = await client.query(
    `select (to_regclass('public.pickup_request') is not null
             and to_regclass('public.pickup_stop') is not null
             and to_regclass('public.pickup_manifest') is not null) as tables,
            to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS "UTC"') as at`,
  );
  const found = probe.rows[0] ?? {};
  const checkedAt = textOf(found.at);
  if (found.tables !== true) return { checkedAt, tables: false, open: [] };

  const rows = await client.query(
    `select r.id as request_id, r.code as request_code, s.id as stop_id, s.state as stop_state,
            m.id as manifest_id, m.code as manifest_code
       from public.pickup_stop s
       join public.pickup_request r on r.id = s.pickup_request_id
       join public.pickup_manifest m on m.id = s.pickup_manifest_id
      where r.state = 'CANCELLED' and s.released_at is null and s.state in ('PENDING', 'ARRIVED')
      order by r.code, s.id`,
  );
  return {
    checkedAt,
    tables: true,
    open: rows.rows.map((row) => ({
      requestId: textOf(row.request_id),
      requestCode: textOf(row.request_code),
      stopId: textOf(row.stop_id),
      stopState: textOf(row.stop_state),
      manifestId: textOf(row.manifest_id),
      manifestCode: textOf(row.manifest_code),
    })),
  };
}

/** What the command prints: what was looked at, what was found, and the result to record. */
export function formatOpenStopReport(database: string, report: OpenStopReport): string {
  const lines = [`open stops of cancelled requests in ${database}, checked ${report.checkedAt}`];
  if (!report.tables) {
    lines.push(
      '  no manifest tables yet (migration 0058 is not applied): no stop can hold a request',
      'result: clear',
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `  cancelled requests that still hold a stop to be worked: ${String(report.open.length)}`,
  );
  for (const each of report.open) {
    lines.push(
      `    ${each.requestCode}  request ${each.requestId}  stop ${each.stopId} (${each.stopState})  run ${each.manifestCode} ${each.manifestId}`,
    );
  }
  lines.push(
    report.open.length === 0
      ? 'result: clear'
      : 'result: NOT clear. Do not apply migration 0065 to this database until each pair above is resolved; nothing was changed by this check.',
  );
  return `${lines.join('\n')}\n`;
}
