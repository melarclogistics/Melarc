import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { timestampOf } from '../platform/database/timestamps.js';
import type {
  HandoverFacts,
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

  async handoverFacts(handle: TransactionHandle, runId: string): Promise<HandoverFacts> {
    // The stops in the order of the run, each with the count the rider recorded at it (a stop that was collected or partly collected has one: the database closes no stop
    // without it, and a record is made for a stop that was arrived at only). A record that is not there is a defect, not a zero.
    const found = await transactionOf(handle).execute(sql`
      select s.pickup_request_id, s.state, c.collected_count
        from pickup_stop s left join collection_record c on c.pickup_stop_id = s.id
       where s.pickup_manifest_id = ${runId}::uuid
       order by s.sequence, s.id`);
    let stopsToWork = 0;
    const collected: { pickupRequestId: string; collectedCount: number }[] = [];
    for (const row of found.rows as unknown as {
      pickup_request_id: string;
      state: string;
      collected_count: number | null;
    }[]) {
      if (row.state === 'PENDING' || row.state === 'ARRIVED') stopsToWork += 1;
      if (row.state === 'COLLECTED' || row.state === 'PARTIALLY_COLLECTED') {
        if (row.collected_count === null) {
          throw new Error('A stop that was collected has no count of the rider to be read');
        }
        collected.push({
          pickupRequestId: row.pickup_request_id,
          collectedCount: row.collected_count,
        });
      }
    }
    return { stopsToWork, collected };
  }

  async completeByHandover(handle: TransactionHandle, runId: string): Promise<Date> {
    // The lock is held by the caller, so the instant is stamped no earlier than anything that committed to the run while it waited.
    const done = await transactionOf(handle).execute(sql`
      update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp()
       where id = ${runId}::uuid and state = 'IN_PROGRESS'
      returning completed_at`);
    const row = done.rows[0] as unknown as { completed_at: string | Date } | undefined;
    // Under the lock and having read the run as in progress, the update cannot miss it.
    if (row === undefined) throw new Error('A locked run in progress was not completed');
    return timestampOf(row.completed_at);
  }

  async recordHandoverCompletion(
    handle: TransactionHandle,
    run: RunFacts,
    holderId: string,
  ): Promise<void> {
    await this.#completion.audit.write(handle, {
      code: 'pickup.manifest.completed',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'PickupManifest', id: run.id },
      responsibleHubId: run.responsibleHubId,
      previousState: 'IN_PROGRESS',
      resultingState: 'COMPLETED',
      relatedIds: { rider_id: holderId },
      detail: { completed_by: 'CUSTODY_HOLDER', cause: 'HUB_HANDOVER' },
    });
  }
}
