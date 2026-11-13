import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';

/**
 * The port through which the custody of a run (the `fleet` domain) reaches the run itself (the `pickup` domain) (S1.24; the readiness check's F-32:
 * "domain-to-domain imports are allowed by no document"; SOLUTION_ARCHITECTURE.md section 5: `platform/` defines narrow ports, a domain implements
 * the one it owns, and the composition root wires them).
 *
 * - **Owner:** `pickup` implements it (`pickup/pickup-run-access.adapter.ts`); `fleet` is the caller. The composition root binds it
 *   (`domain-ports.module.ts`).
 * - **Inputs:** the caller's transaction handle, always, and the identifier of a run.
 * - **Transactional requirement: the caller's own transaction, and no other.** Every method takes the handle of the use case's transaction and
 *   runs on it: it opens no transaction, takes no connection of its own, commits nothing and hands nothing to a queue or an event. What it reads, it
 *   reads under the caller's security context (a run the caller cannot see is `undefined`, as it is for a read of the run), and what it writes is
 *   rolled back with the act that called it. An act that opens a custody handover, resolves one and completes the run that a resolution settles is
 *   one atomic piece of work under one order of locks (state-machines.md section 4), and this port is what keeps it so: a port that made those
 *   separate calls, or an asynchronous event, would break it.
 * - **Locks:** `peek` takes none; `lock` and `lockWithVersion` take the run's own lock and no other (never its stops'); `completeIfSettled` follows the
 *   order of locks of `pickup/pickup-run-completion.ts`. A caller takes the run's lock before the lock of anything it owns.
 */

/** Why the system is completing a run: the act that made its last piece of work terminal. */
export type RunCompletionCause =
  'LAST_STOP_SKIPPED' | 'LAST_STOP_FAILED' | 'LAST_PICKUP_CANCELLED' | 'CUSTODY_HANDOVER_RESOLVED';

/** The facts of a run that a caller outside its domain may rely on, and nothing else of it. */
export interface RunFacts {
  readonly id: string;
  /** The run's state, as the contract names it (`IN_PROGRESS`, ...). */
  readonly state: string;
  /** The hub responsible for the run. */
  readonly responsibleHubId: string;
}

/** A run read under its lock with the version a mutation compares `If-Match` with: opaque to the caller. */
export interface VersionedRun extends RunFacts {
  readonly etag: string;
}

/** A pickup request that was collected on a run, with what the rider counted for it at the door (the collection record's count). */
export interface CollectedRequest {
  readonly pickupRequestId: string;
  readonly collectedCount: number;
}

/**
 * What the hub handover (S1.31, the `hub` domain) needs to judge of a run's stops: how many are still to be worked, and the requests that were collected or
 * partly collected on it, **in the order of the run's stops**. The count of each is the collection record's, read so that a correction of the rider's pre-fill is
 * recorded; it is never an input of the declaration.
 */
export interface HandoverFacts {
  /** The stops still to be worked (`PENDING` or `ARRIVED`). */
  readonly stopsToWork: number;
  readonly collected: readonly CollectedRequest[];
}

export interface RunAccess {
  /**
   * The run as the caller may see it, with no lock. `undefined` when there is none such for the caller (it does not exist, or it is out of the
   * caller's scope: the two are not told apart).
   */
  peek(handle: TransactionHandle, runId: string): Promise<RunFacts | undefined>;

  /** The run under its lock (`for update`), and nothing else of it is locked or read. `undefined` when there is none such for the caller. */
  lock(handle: TransactionHandle, runId: string): Promise<RunFacts | undefined>;

  /**
   * The run under its lock, read with its stops so that its version is the one a read of the run answers with. `undefined` when there is none such for
   * the caller.
   */
  lockWithVersion(handle: TransactionHandle, runId: string): Promise<VersionedRun | undefined>;

  /**
   * `If-Match` is exactly the version of the run as it is now, under its lock. **Failure outcome:** `STATE_CONFLICT` (an `ApiException`) for a
   * missing, weak, stale or foreign token: the caller read a run that is not the one that is there.
   */
  requireCurrentVersion(ifMatch: string | undefined, run: VersionedRun): void;

  /**
   * Completes the run, as the system and in the caller's transaction, if it is in progress with nothing left to work, nothing collected and no custody
   * handover pending; says whether it did. Called once the act has written what makes the run's last piece of work terminal, by a context whose key
   * the run's policy admits for the completion.
   */
  completeIfSettled(
    handle: TransactionHandle,
    runId: string,
    cause: RunCompletionCause,
  ): Promise<boolean>;

  /**
   * The stops of the run as the hub handover judges them (S1.31): the stops still to be worked and the requests collected, with their counts. Read under the caller's
   * own context (a rider that holds the run's parcels reads its stops and their records under the key of the handover), after the run's lock is held.
   */
  handoverFacts(handle: TransactionHandle, runId: string): Promise<HandoverFacts>;

  /**
   * Completes the run **by the hub handover** (S1.31) and answers the moment it was completed (the database's own, which is the receipt of the handover). The run is in progress
   * and held under its lock; the database holds that the writer is the custody holder, that nothing is still to be worked, none is pending and something was collected, and, at the
   * end of the transaction, that the intakes the handover opens are exactly the run's collected requests. It writes the state and its moment and nothing else, and no event: the
   * caller writes the handover's own, then `recordHandoverCompletion`.
   */
  completeByHandover(handle: TransactionHandle, runId: string): Promise<Date>;

  /** Writes the event of the run's completion by the hub handover, in the name of the custody holder who handed over (`pickup.manifest.completed`), after the act's own events. */
  recordHandoverCompletion(
    handle: TransactionHandle,
    run: RunFacts,
    holderId: string,
  ): Promise<void>;
}

/** The injection token of the port; bound once, by the composition root. */
export const RUN_ACCESS = Symbol('RUN_ACCESS');
