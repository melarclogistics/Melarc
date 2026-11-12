import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { transactionOf } from '../database/transaction-handle.js';

/**
 * The primary hub of a staff member, the baseline of a hub crossing (audit.md section 5.4): `null` for one with none (a Platform Admin without a
 * hub crosses every hub it reads). Read in the transaction of the search, where a staff member's own row is readable under any key (migration
 * 0016), as the lists of the pickup, manifest, rider and message log domains read it.
 */
export async function primaryHubOfStaff(
  handle: TransactionHandle,
  principalId: string,
): Promise<string | null> {
  const own = await transactionOf(handle).execute(
    sql`select primary_hub_id from staff_identity where id = ${principalId}::uuid`,
  );
  return (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id ?? null;
}
