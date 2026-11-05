import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { RunCustody } from '../platform/domain-ports/run-custody.port.js';

/**
 * The `fleet` domain's side of the custody port (`platform/domain-ports/run-custody.port.ts`, S1.24): what the run may know of its parcels' custody.
 * It reads the custody table, which this domain owns, on the handle it is given, so the answer is the one the caller's own key may see, and a
 * handover that the same transaction opened and has not committed is seen. It opens no transaction and writes nothing.
 */
export class FleetRunCustody implements RunCustody {
  async hasPendingHandover(handle: TransactionHandle, runId: string): Promise<boolean> {
    const found = await transactionOf(handle).execute(
      sql`select 1 from run_custody_handover where manifest_id = ${runId}::uuid and state = 'PENDING' limit 1`,
    );
    return found.rows.length > 0;
  }
}
