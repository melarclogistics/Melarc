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
}

/** The injection token of the port; bound once, by the composition root. */
export const RUN_ACCESS = Symbol('RUN_ACCESS');
