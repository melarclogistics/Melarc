import { sql, type SQL } from 'drizzle-orm';

import type { transactionOf } from '../platform/database/transaction-handle.js';
import {
  intakeFindingOf,
  type AfterCount,
  type HubIntakeRow,
  type IntakeFindingRow,
  type IntakeFindingView,
} from './hub-intake-view.js';

/** What `melarc.hub_intake_after_count` and `melarc.commit_blind_count` answer for an intake: the declaration and the photos of the parcels counted at the door. */
export interface AfterCountRow {
  readonly intake_id: string;
  readonly rider_declared_count: number;
  readonly parcel_photo_ids: readonly string[];
}

/** An answer of the database as what the view of a counted intake takes, with the findings made since the count. */
export const afterCountOf = (
  row: AfterCountRow,
  findings: readonly IntakeFindingView[] = [],
): AfterCount => ({
  declared: row.rider_declared_count,
  photoIds: row.parcel_photo_ids,
  findings,
});

/** The findings of the intakes given, by intake, in the order they were made (`pickup_intake_finding`: the staff of the intake's hubs read them, and none exists before the count). */
export async function findingsOf(
  tx: ReturnType<typeof transactionOf>,
  intakeIds: readonly string[],
): Promise<ReadonlyMap<string, readonly IntakeFindingView[]>> {
  if (intakeIds.length === 0) return new Map();
  const ids: SQL = sql.join(
    intakeIds.map((intake) => sql`${intake}::uuid`),
    sql`, `,
  );
  const found = await tx.execute(sql`
    select id, pickup_intake_id, kind, condition, outcome, note, evidence_ids, recorded_by, recorded_at
      from pickup_intake_finding where pickup_intake_id = any(array[${ids}]::uuid[]) order by recorded_at, id`);
  const by = new Map<string, IntakeFindingView[]>();
  for (const row of found.rows as unknown as IntakeFindingRow[]) {
    by.set(row.pickup_intake_id, [...(by.get(row.pickup_intake_id) ?? []), intakeFindingOf(row)]);
  }
  return by;
}

/**
 * What each intake of the rows that has been counted carries beyond the columns the login can read, from the one function that answers it (`melarc.hub_intake_after_count`, migration
 * `0094`): an intake that has not been counted has none and is never asked for, and a page of intakes that have not been counted makes no such call at all. **The only line of the
 * receiving side's reads that names the declaration is the call of this function.**
 */
export async function afterCountsOf(
  tx: ReturnType<typeof transactionOf>,
  rows: readonly HubIntakeRow[],
): Promise<ReadonlyMap<string, AfterCount>> {
  const counted = rows.filter((row) => row.physical_count !== null).map((row) => row.id);
  if (counted.length === 0) return new Map();
  const ids: SQL = sql.join(
    counted.map((intake) => sql`${intake}::uuid`),
    sql`, `,
  );
  const answered = await tx.execute(
    sql`select intake_id, rider_declared_count, parcel_photo_ids from melarc.hub_intake_after_count(array[${ids}]::uuid[])`,
  );
  const findings = await findingsOf(tx, counted);
  return new Map(
    (answered.rows as unknown as AfterCountRow[]).map((each) => [
      each.intake_id,
      afterCountOf(each, findings.get(each.intake_id)),
    ]),
  );
}
