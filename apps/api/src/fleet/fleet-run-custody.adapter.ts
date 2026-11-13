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

  async holderOf(handle: TransactionHandle, runId: string): Promise<string | null> {
    // `melarc.run_custody_holder` reads the custody table and the run under the caller's own row-level security. The caller of the hub handover sees the handovers it is a party to
    // (the key is given that read), and a transfer out of a holder is always one it is a party to, so what it reads is enough to know whether it is the holder.
    const found = await transactionOf(handle).execute(
      sql`select melarc.run_custody_holder(${runId}::uuid) as holder`,
    );
    const holder = (found.rows[0] as { holder: string | null } | undefined)?.holder;
    return holder ?? null;
  }
}
