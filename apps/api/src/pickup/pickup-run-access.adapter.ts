import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type {
  RunAccess,
  RunCompletionCause,
  RunFacts,
  VersionedRun,
} from '../platform/domain-ports/run-access.port.js';
import { loadManifest, requireCurrentManifest } from './pickup-manifest-loader.js';
import { completeRunIfSettled, type RunCompletionDependencies } from './pickup-run-completion.js';

interface RunRow {
  readonly id: string;
  readonly state: string;
  readonly responsible_hub_id: string;
}

const factsOf = (row: RunRow): RunFacts => ({
  id: row.id,
  state: row.state,
  responsibleHubId: row.responsible_hub_id,
});

/**
 * The `pickup` domain's side of the run port (`platform/domain-ports/run-access.port.ts`, S1.24): what another domain may do with a run, in the
 * caller's own transaction. **It is a thin shell over what the domain already does for itself** (the manifest's loader and its token, the completion by
 * the system), so a run is read, locked, versioned and completed by one piece of code whoever asks, and the order of locks written at the completion is
 * the order every caller gets. It holds no connection and opens no transaction: every method works on the handle it is given.
 */
export class PickupRunAccess implements RunAccess {
  readonly #completion: RunCompletionDependencies;

  constructor(completion: RunCompletionDependencies) {
    this.#completion = completion;
  }

  async peek(handle: TransactionHandle, runId: string): Promise<RunFacts | undefined> {
    const found = await transactionOf(handle).execute(
      sql`select id, state, responsible_hub_id from pickup_manifest where id = ${runId}::uuid`,
    );
    const row = found.rows[0] as unknown as RunRow | undefined;
    return row === undefined ? undefined : factsOf(row);
  }

  async lock(handle: TransactionHandle, runId: string): Promise<RunFacts | undefined> {
    const found = await transactionOf(handle).execute(
      sql`select id, state, responsible_hub_id from pickup_manifest where id = ${runId}::uuid for update`,
    );
    const row = found.rows[0] as unknown as RunRow | undefined;
    return row === undefined ? undefined : factsOf(row);
  }

  async lockWithVersion(
    handle: TransactionHandle,
    runId: string,
  ): Promise<VersionedRun | undefined> {
    const loaded = await loadManifest(handle, runId, { lock: true });
    return loaded === undefined ? undefined : { ...factsOf(loaded.row), etag: loaded.etag };
  }

  requireCurrentVersion(ifMatch: string | undefined, run: VersionedRun): void {
    requireCurrentManifest(ifMatch, run);
  }

  async completeIfSettled(
    handle: TransactionHandle,
    runId: string,
    cause: RunCompletionCause,
  ): Promise<boolean> {
    return (await completeRunIfSettled(this.#completion, handle, runId, cause)) !== undefined;
  }
}
