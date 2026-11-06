import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { transactionOf } from '../database/transaction-handle.js';

/**
 * The names of hubs, by id, as the `hub` registry holds them (`hub_read` admits any staff context): the display name a result gives the hub of
 * its record (`RecordLookupResult.hub`), read in the transaction that read the records. A label for the interface, never authority: the
 * records were found under the grant of their key, and this reads names of the hubs they belong to. A hub the registry does not hold is not in
 * the answer (the caller refuses a result it cannot name). The ids are the database's own, read from the rows found.
 *
 * **This read is not scoped to the session's hubs**, because the registry admits any staff context (`hub_read`): it is safe only because every
 * id given to it comes from a row the caller has just found under the grant of that row's kind, so it names hubs those rows belong to and no other.
 * Never give it an id that did not come from such a row.
 */
export async function hubNamesOf(
  handle: TransactionHandle,
  hubIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (hubIds.length === 0) return new Map();
  const listed = await transactionOf(handle).execute(
    sql`select id, name from hub where id = any(${`{${hubIds.join(',')}}`}::uuid[])`,
  );
  return new Map(
    (listed.rows as unknown as readonly { id: string; name: string }[]).map(
      (row) => [row.id, row.name] as const,
    ),
  );
}
