import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';

/**
 * The port through which the run (the `pickup` domain) learns what it must know of the custody of its parcels (the `fleet` domain) (S1.24; F-32; see
 * `run-access.port.ts`, whose rules this port keeps).
 *
 * - **Owner:** `fleet` implements it (`fleet/fleet-run-custody.adapter.ts`); `pickup` is the caller (the completion of a run). The composition root
 *   binds it (`domain-ports.module.ts`).
 * - **Inputs:** the caller's transaction handle and the identifier of a run.
 * - **Transactional requirement: the caller's own transaction.** It reads on the handle it is given, under the caller's security context, and so sees
 *   the custody records the caller's key may read (the table's policy lists them), including what the same transaction has written and not yet
 *   committed. It opens no transaction and writes nothing.
 * - **Timing:** the completion of a run asks it **after** it holds the run's lock. The acts that change a run's custody take the run's lock first, so
 *   while the completion holds it the answer cannot change under it.
 */
export interface RunCustody {
  /** Whether a custody handover of the run is pending: opened, and neither accepted nor failed. */
  hasPendingHandover(handle: TransactionHandle, runId: string): Promise<boolean>;
}

/** The injection token of the port; bound once, by the composition root. */
export const RUN_CUSTODY = Symbol('RUN_CUSTODY');
