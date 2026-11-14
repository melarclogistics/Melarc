import { sql, type SQL } from 'drizzle-orm';

import type { transactionOf } from '../platform/database/transaction-handle.js';
import type { AfterCount, HubIntakeRow } from './hub-intake-view.js';

/** What `melarc.hub_intake_after_count` and `melarc.commit_blind_count` answer for an intake: the declaration and the photos of the parcels counted at the door. */
export interface AfterCountRow {
  readonly intake_id: string;
  readonly rider_declared_count: number;
  readonly parcel_photo_ids: readonly string[];
}

/** An answer of the database as what the view of a counted intake takes. */
export const afterCountOf = (row: AfterCountRow): AfterCount => ({
  declared: row.rider_declared_count,
  photoIds: row.parcel_photo_ids,
});

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
  return new Map(
    (answered.rows as unknown as AfterCountRow[]).map((each) => [
      each.intake_id,
      afterCountOf(each),
    ]),
  );
}
