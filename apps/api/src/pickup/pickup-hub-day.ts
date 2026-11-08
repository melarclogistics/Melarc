import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { hubLocal } from './cutoff.js';

/**
 * Today's date on the hub's clock, from the database's instant: the day is the database's, as the booking cutoff's is, and no setting or
 * client moves it. The clock is one for every hub (`HUB_TIME_ZONE`). A manifest's day is judged against it when the manifest is made
 * (`createPickupManifest`) and when it is sent out (`dispatchManifest`): a run is not made for a day that has passed, and not sent out after
 * its day has passed (the Product Owner, 2 November 2026).
 */
export async function hubToday(handle: TransactionHandle): Promise<string> {
  const found = await transactionOf(handle).execute(sql`select clock_timestamp() as instant`);
  const instant = (found.rows[0] as { instant: string | Date } | undefined)?.instant;
  if (instant === undefined) throw new Error('The database gave no time');
  return hubLocal(instant instanceof Date ? instant : new Date(instant)).date;
}
