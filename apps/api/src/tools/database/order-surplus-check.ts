import { CliUsageError } from './cli.js';
import type { SqlClient } from './provisioning.js';

/**
 * The inventory of a surplus that already stands (Stage 7, OB-S1-161; the Product Owner's decision of 22 November 2026): **an intake counted blind with more orders than parcels received**, open or closed.
 *
 * Migration `0119` holds every order of a blind intake to its count (`orders_exceed_received`) and the close refuses to close over a surplus, but a surplus made before it stands as it was: the table's guard
 * checks what is written, not what is already there, and the queue of the closes that left work (`listClosedIntakeExceptions`) lists shortages (received more than ordered) and never an older surplus. This
 * is the read that finds one. It says what is there and **repairs nothing**: the Product Owner's decision is that a database of disposable development data is rebuilt (the clean-migration approach), and that
 * a retained operational record needs the parcels recounted and verified, and then an audited correction of the specific order. The received count is never raised to make the totals agree.
 *
 * **Why a command and not part of the migration, and why it needs the administrator's login.** The migration login and the runtime login read these tables through forced row-level security like any other
 * login, and the policies show a login with no hub scope no row: a check made there answers "nothing" because it could not see, which is the mistake this exists to avoid.
 *
 * It only reads. It has no flag that writes. The exit code is 0 when it is clear, 2 when it found a surplus, and 1 on a failure.
 */
export const ORDER_SURPLUS_USAGE =
  'usage: node dist/tools/db-order-surplus.js [database]   (default database: melarc_dev; it only reads)';

export interface OrderSurplusArguments {
  readonly database: string;
}

/** The database (default `melarc_dev`). There is no flag: the inventory changes nothing. */
export function parseOrderSurplusArguments(argv: readonly string[]): OrderSurplusArguments {
  const databases: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith('-')) {
      throw new CliUsageError(`unknown option ${argument.slice(0, 40)}. ${ORDER_SURPLUS_USAGE}`);
    }
    databases.push(argument);
  }
  if (databases.length > 1) {
    throw new CliUsageError(`one database at a time. ${ORDER_SURPLUS_USAGE}`);
  }
  return { database: databases[0] ?? 'melarc_dev' };
}

export interface OrderSurplus {
  readonly intakeId: string;
  readonly intakeCode: string;
  readonly state: string;
  readonly receivedCount: number;
  readonly standingOrders: number;
  readonly surplus: number;
  readonly closedAt: string | null;
}

export interface OrderSurplusReport {
  /** The database's clock when the check was made, for the record. */
  readonly checkedAt: string;
  /** Whether the intake and order tables exist: without them there is nothing to hold a surplus. */
  readonly tables: boolean;
  /** How many blind intakes (open and closed) with a count were looked at. */
  readonly looked: number;
  readonly surpluses: readonly OrderSurplus[];
}

export const isClear = (report: OrderSurplusReport): boolean => report.surpluses.length === 0;

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Looks at every intake counted blind, open and closed, and says which has more orders standing than parcels received. An order whose arrival was reversed does not stand (`REVERSED`), as the guards count.
 * Changes nothing.
 */
export async function checkOrderSurplus(client: SqlClient): Promise<OrderSurplusReport> {
  const probe = await client.query(
    `select (to_regclass('public.pickup_intake') is not null and to_regclass('public."order"') is not null) as tables,
            to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS "UTC"') as at`,
  );
  const found = probe.rows[0] ?? {};
  const checkedAt = textOf(found.at);
  if (found.tables !== true) return { checkedAt, tables: false, looked: 0, surpluses: [] };

  const rows = await client.query(
    `select i.id as intake_id, i.code as intake_code, i.state, i.physical_count as received,
            count(o.id) filter (where o.commercial_state is distinct from 'REVERSED') as standing,
            to_char(i.closed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS "UTC"') as closed_at
       from public.pickup_intake i
       left join public."order" o on o.pickup_intake_id = i.id
      where i.receiving_mode = 'BLIND_COUNT' and i.physical_count is not null
      group by i.id
     order by i.code, i.id`,
  );
  const counted = rows.rows.map((row) => ({
    intakeId: textOf(row.intake_id),
    intakeCode: textOf(row.intake_code),
    state: textOf(row.state),
    receivedCount: numberOf(row.received),
    standingOrders: numberOf(row.standing),
    closedAt: typeof row.closed_at === 'string' ? row.closed_at : null,
  }));
  return {
    checkedAt,
    tables: true,
    looked: counted.length,
    surpluses: counted
      .filter((each) => each.standingOrders > each.receivedCount)
      .map((each) => ({ ...each, surplus: each.standingOrders - each.receivedCount })),
  };
}

/** What the command prints: what was looked at, what was found, and the result to record. */
export function formatOrderSurplusReport(database: string, report: OrderSurplusReport): string {
  const lines = [`orders beyond the parcels received, in ${database}, checked ${report.checkedAt}`];
  if (!report.tables) {
    lines.push('  no intake or order tables yet: nothing can hold a surplus', 'result: clear');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `  intakes counted blind (open and closed) that were looked at: ${String(report.looked)}`,
    `  intakes with more orders than parcels received: ${String(report.surpluses.length)}`,
  );
  for (const each of report.surpluses) {
    lines.push(
      `    ${each.intakeCode}  intake ${each.intakeId}  ${each.state}${each.closedAt === null ? '' : ` (closed ${each.closedAt})`}  received ${String(each.receivedCount)}, orders ${String(each.standingOrders)}, surplus ${String(each.surplus)}`,
    );
  }
  lines.push(
    report.surpluses.length === 0
      ? 'result: clear'
      : 'result: NOT clear. Nothing was changed by this check. A database of disposable development data is rebuilt; a retained record needs the parcels recounted and verified and then an audited correction of the specific order (never a raised count).',
  );
  return `${lines.join('\n')}\n`;
}
