import pg from 'pg';

import type { Clock } from '../auth/ports/clock.port.js';
import { ExecutionBudget } from '../execution/execution-budget.js';
import { ConnectionQueue, type Permit } from './connection-queue.js';

/**
 * Cancelling the statement a connection is running (S0.6; OB-37). Closing a client's socket does **not** stop a running
 * statement: the backend goes on until the statement ends and only then notices. So when a budget expires mid-statement, the
 * database layer asks the server to cancel it, from a connection that is not the busy one.
 *
 * - `signalled`: the server was asked to cancel the backend's running statement. The backend acts on it a moment later, so
 *   this is a request that was sent and not proof that the statement stopped; the statement's own failure is that proof.
 * - `not-found`: no session of this role and database has that process id (it already ended).
 * - `failed`: the cancel could not be made (no connection, no answer within the bound, the server declined). The server-side
 *   timeouts remain the bound on the statement.
 *
 * It never throws and never takes longer than its bound, counted from the moment it is asked.
 */
export type CancelOutcome = 'signalled' | 'not-found' | 'failed';

export interface StatementCanceller {
  cancel(processId: number): Promise<CancelOutcome>;
}

/** The backend of the same role and database, never this connection's own. pid-reuse cannot reach another role's session. */
const CANCEL_SQL = `select pg_cancel_backend(pid) as signalled from pg_stat_activity where pid = $1 and usename = current_user and datname = current_database() and pid <> pg_backend_pid()`;

type CancelClient = Pick<pg.Client, 'connect' | 'query' | 'end' | 'on'>;

/** Development-qualified (plan section 3): a cancel is a few milliseconds, so four at once clear a burst without a storm. */
const DEFAULT_MAX_CONCURRENT = 4;
/** Cancels waiting for a turn beyond this are refused at once (they fail; the server's own time bounds remain). */
const MAX_WAITING_CANCELS = 256;

export interface PgStatementCancellerOptions {
  /**
   * The longest the whole cancel may take, from the moment it is asked: the wait for its turn, connecting, the statement and
   * closing the connection all draw on this one bound. Finite and positive.
   */
  readonly timeoutMilliseconds: number;
  /** The clock the bound is measured on (its monotonic reading), so that a test moves time by hand. */
  readonly clock: Clock;
  /** The most cancel connections open at once, so that a stall that expires every request at once is not a storm of connections. */
  readonly maxConcurrent?: number;
  /** A test supplies its own client. */
  readonly makeClient?: (config: pg.ClientConfig) => CancelClient;
}

/** Ends a connection. It neither throws nor rejects, whether the close fails at once or later: a failed close is nothing to report. */
async function close(client: CancelClient): Promise<void> {
  try {
    await client.end();
  } catch {
    // The connection is gone either way.
  }
}

export class PgStatementCanceller implements StatementCanceller {
  private readonly timeoutMilliseconds: number;
  private readonly clock: Clock;
  private readonly makeClient: (config: pg.ClientConfig) => CancelClient;
  private readonly turns: ConnectionQueue;

  /** `settings` are the checked connection facts the pool is made from (`postgresConnectionSettings`), never a URL. */
  constructor(
    private readonly settings: pg.ClientConfig,
    options: PgStatementCancellerOptions,
  ) {
    if (!Number.isFinite(options.timeoutMilliseconds) || options.timeoutMilliseconds <= 0) {
      throw new RangeError('The bound on a cancel is a finite, positive number of milliseconds');
    }
    this.timeoutMilliseconds = options.timeoutMilliseconds;
    this.clock = options.clock;
    this.makeClient = options.makeClient ?? ((config) => new pg.Client(config));
    this.turns = new ConnectionQueue({
      capacity: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxWaiters: MAX_WAITING_CANCELS,
    });
  }

  async cancel(processId: number): Promise<CancelOutcome> {
    if (!Number.isInteger(processId) || processId <= 0) return 'failed';
    // One budget for the whole cancel, started now: the wait for a turn, the connection, the statement and the close all draw on
    // it, and none is given a fresh one when the phase before it ends.
    const budget = new ExecutionBudget(this.clock, 'cancel', this.timeoutMilliseconds);
    try {
      return await this.within(processId, budget);
    } catch {
      return 'failed';
    } finally {
      budget.finish();
    }
  }

  private async within(processId: number, budget: ExecutionBudget): Promise<CancelOutcome> {
    let turn: Permit;
    try {
      turn = await this.turns.acquire({
        timeoutMilliseconds: Math.max(1, budget.remainingMilliseconds()),
        signal: budget.signal,
      });
    } catch {
      return 'failed';
    }
    try {
      // A turn can be handed over at the very moment the bound passes: then there is nothing left to connect with.
      if (budget.expired) return 'failed';
      // The connection is given only what is left of the bound, not the whole of it again.
      const left = Math.max(1, Math.ceil(budget.remainingMilliseconds()));
      const client = this.makeClient({
        ...this.settings,
        application_name: 'melarc-api-cancel',
        connectionTimeoutMillis: left,
        statement_timeout: left,
      });
      // An error on this connection must not be an uncaught exception: the cancel simply failed.
      client.on('error', () => undefined);

      const over = new Promise<void>((resolve) => {
        budget.onExpiry(() => {
          resolve();
        });
      });
      const outcome = await Promise.race([
        this.signal(client, processId, budget),
        over.then((): CancelOutcome => 'failed'),
      ]);
      // The attempt may still be running (the bound won): closing the client ends it, and whatever it settles with later is
      // already handled. The close is waited for only until the bound, and then not at all: the turn goes back either way.
      await Promise.race([close(client), over]);
      return outcome;
    } finally {
      turn.release();
    }
  }

  private async signal(
    client: CancelClient,
    processId: number,
    budget: ExecutionBudget,
  ): Promise<CancelOutcome> {
    try {
      await client.connect();
      // A connection that arrives after the bound is not used: the caller has been told the cancel failed, and the process id may
      // name another statement, or another session, by now.
      if (budget.expired || budget.closed) return 'failed';
      const result = await client.query<{ signalled: boolean }>(CANCEL_SQL, [processId]);
      const row = result.rows[0];
      if (row === undefined) return 'not-found';
      return row.signalled ? 'signalled' : 'failed';
    } catch {
      return 'failed';
    }
  }
}
