import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

import type { Clock } from '../auth/ports/clock.port.js';
import type { DatabaseDeadlines } from '../config/load-config.js';
import {
  BudgetExpiredError,
  ExecutionBudget,
  currentBudget,
  runWithBudget,
} from '../execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../execution/execution-parameters.js';
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  ReadinessRegistry,
  type ReadinessCheckOptions,
} from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { withinBudget } from '../lifecycle/within-budget.js';
import { DATABASE_POOL, DATABASE_RUNTIME, LOGGER } from '../platform.tokens.js';
import { capabilityPermittedFor } from './capability-access.js';
import { AcquireTimeoutError, ConnectionQueue } from './connection-queue.js';
import {
  CommitOutcomeUnknownError,
  TransactionRolledBackError,
  asError,
  closedIn,
  commandTagOf,
  deadlineFrom,
  isDefiniteRefusal,
  serverErrorIn,
} from './database-failures.js';
import { ROLE_POSTURE_SQL, rolePostureParameters, unsafeFlags } from './role-posture.js';
import type { CancelOutcome, StatementCanceller } from './statement-canceller.js';
import { registerExclusiveGate } from './transaction-gate.js';
import { registerTransactionFacts, transactionFacts } from './transaction-facts.js';
import {
  SecurityContextError,
  frozenContextCopy,
  toContextSettings,
  type SecurityContext,
} from './transaction-context.js';

/**
 * What the work inside a transaction receives: queries on the one connection the transaction holds. It cannot open
 * a transaction of its own: the one it runs in is the only one there is, and it ends when the work does.
 */
export type DatabaseTransaction = Omit<NodePgDatabase, 'transaction'>;

/**
 * What the service needs besides its pool (S0.6): the `Clock` the budgets measure time on, the pool size and the deadlines from
 * the configuration, and the way to cancel a statement another connection is running.
 */
export interface DatabaseRuntime {
  readonly clock: Clock;
  readonly poolMax: number;
  readonly deadlines: DatabaseDeadlines;
  readonly canceller: StatementCanceller;
}

/** Set while a transaction's work runs, so that a transaction opened inside it is seen for what it is. */
const openTransaction = new AsyncLocalStorage<true>();

/** Where a transaction was when its budget ran out. */
type Phase = 'beginning' | 'working' | 'committing';

/** A pooled connection and the permit that goes with it. Giving it back gives back both, once. */
interface Lease {
  readonly client: PoolClient;
  /** The last error the connection raised while it was held, if any (the server ending the session, say). */
  readonly connectionError: () => Error | undefined;
  /** Returns the connection to the pool, or destroys it when given an error. A connection that raised one is destroyed. */
  readonly release: (error?: Error) => void;
}

/** The connection's process id, which the server knows it by. Not a typed part of the driver's public surface. */
function processIdOf(client: PoolClient): number | undefined {
  const id = (client as unknown as { processID?: number | null }).processID;
  return typeof id === 'number' ? id : undefined;
}

/** Races a promise against a budget's expiry. The promise is not cancelled: its owner decides what becomes of its result. */
function untilExpired<T>(promise: Promise<T>, budget: ExecutionBudget): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const remove = budget.onExpiry(reject);
    promise.then(
      (value) => {
        remove();
        resolve(value);
      },
      (error: unknown) => {
        remove();
        reject(asError(error));
      },
    );
  });
}

/**
 * The API's one door to PostgreSQL: a lazily connecting pool, readiness, shutdown and transactions.
 *
 * Protected work belongs in `transactionWithContext`, which opens a transaction and sets the security
 * context transaction-locally, so it is discarded at commit or rollback and can never persist on a pooled
 * connection (SECURITY_DESIGN.md §14.1). There is deliberately no way to set session-level state, and the pool,
 * the driver handle and a transaction without a context are not exposed.
 *
 * **Time (S0.6; SECURITY_DESIGN.md §14.6; plan section 11.8).** Every wait here is bounded, and a bound is enforced, not
 * raced: a caller waits for a connection in a bounded line (`ConnectionQueue`) whose abandoned waiters are removed, and the wait
 * and the connecting draw on one acquisition deadline; a connection carries the server's statement, lock and
 * idle-in-transaction timeouts from the moment it is made, and each transaction is given the server's transaction timeout; a
 * transaction runs under an `ExecutionBudget` (a child of the request's, when there is one) that cancels the running statement,
 * rolls back, and destroys the connection on expiry; and the readiness probe has a deadline of its own that ends what it holds.
 */
@Injectable()
export class DatabaseService {
  private ended = false;
  private reportedUnsafeRole = false;
  private readonly clock: Clock;
  private readonly deadlines: DatabaseDeadlines;
  private readonly canceller: StatementCanceller;
  private readonly queue: ConnectionQueue;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
    shutdown: ShutdownRegistry,
    readiness: ReadinessRegistry,
    @Inject(DATABASE_RUNTIME) runtime: DatabaseRuntime,
  ) {
    if (
      !Number.isFinite(runtime.deadlines.transactionTimeoutMs) ||
      runtime.deadlines.transactionTimeoutMs <= 0
    ) {
      throw new RangeError('The transaction time is a finite, positive number of milliseconds');
    }
    this.clock = runtime.clock;
    this.deadlines = runtime.deadlines;
    this.canceller = runtime.canceller;
    // One permit per pooled connection: whoever holds a permit is not made to wait inside the driver's own, unbounded, queue.
    this.queue = new ConnectionQueue({
      capacity: runtime.poolMax,
      maxWaiters: runtime.deadlines.maxWaiters,
    });
    // An idle client can fail (the database restarting). Without a listener that is an uncaught exception.
    pool.on('error', (error) => {
      this.logger.error({ err: error }, 'idle database client error');
    });
    // The pool's listener covers a client only while it sits idle: at checkout the pool takes it off. A connection
    // lost while a transaction holds the client (a restart, a failover, a terminated backend) would then be an
    // `error` event with nobody listening, which is an uncaught exception and ends the process. A listener of our
    // own stays for the client's whole life; the query or transaction that was using it fails through its own
    // path, and the request that made it answers with the platform's 500.
    pool.on('connect', (client) => {
      client.on('error', (error) => {
        this.logger.error({ err: error }, 'database client error');
      });
    });
    shutdown.register({ name: 'database-pool', close: () => this.close() });
    readiness.register({ name: 'database', check: (options) => this.check(options) });
  }

  /**
   * A transaction whose security context is set before the work runs. An invalid context is refused
   * before a connection is taken, so nothing reaches the pool (§14.1b). It is the only way in: there is no
   * context-free transaction and no driver handle (S0.4c), so no protected statement runs without a validated context.
   */
  async transactionWithContext<T>(
    context: SecurityContext,
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const settings = toContextSettings(context);
    // Taken in the same synchronous step as the validation: this copy is what was validated, and what the transaction runs under.
    const fixedContext = frozenContextCopy(context);
    return this.runInTransaction(async (tx) => {
      const assignments = settings.map(([name, value]) => sql`set_config(${name}, ${value}, true)`);
      // The role comes back from the statement that sets the context: it is what the database says this connection
      // runs as, and a SYSTEM capability is opened only over the identity that holds its grants (§14.1b).
      const applied = await tx.execute(
        sql`select ${sql.join(assignments, sql`, `)}, current_user as database_role`,
      );
      // The context is configuration, not data: what the work issues from here is counted (the policy locks come before it).
      transactionFacts(tx)?.markContextApplied(fixedContext);
      // Judged on the copy that was validated and applied, not on the caller's object, which it may have changed since.
      const capability = fixedContext.taskCapability;
      if (
        fixedContext.principalType === 'SYSTEM' &&
        (capability === undefined ||
          !capabilityPermittedFor(capability, applied.rows[0]?.database_role as string | undefined))
      ) {
        throw new SecurityContextError(['taskCapability']);
      }
      return work(tx);
    });
  }

  /**
   * Runs the work in a transaction on one connection that this method takes and gives back. It does not use
   * drizzle's own `transaction`, which has three defects the security context cannot afford: it sends BEGIN before
   * the block that releases the connection, so a failed BEGIN leaks the connection; it returns a connection whose
   * ROLLBACK failed to the pool, with the failed request's context still set on it; and it hands out a transaction
   * object that goes on working after the transaction has ended, on a connection another request may be using.
   *
   * A connection that failed to begin, to roll back or to commit is destroyed and not reused, and so is one the server's
   * own time bounds ended work on, and one that raised an error while it was held. The transaction object stops working when
   * the transaction ends. A transaction opened inside another is refused: it would hold a second connection while the first
   * is held, and as many such requests as the pool has connections wait for each other for ever.
   *
   * **When the transaction's budget runs out** (the request's, if that is shorter) the caller is not left waiting while the
   * work goes on: further statements are refused at once; a statement that is running is cancelled from another connection;
   * the transaction is rolled back; and the connection is destroyed whatever the rollback said, all within
   * `DISPOSAL_BOUND_MS`. Work that finishes later is never committed: its result is dropped and the lateness is logged. A
   * budget that runs out **while COMMIT is in flight** is a different case: nothing can say whether the commit happened, so
   * the caller gets `CommitOutcomeUnknownError`, no rollback is sent and none is claimed.
   */
  private async runInTransaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    if (openTransaction.getStore() === true) {
      throw new Error(
        'A transaction is already open in this request: do the work in it, a second one would hold a second connection',
      );
    }

    const request = currentBudget();
    // A request that ran out, or that has been answered, begins nothing: a continuation that kept its scope cannot reopen it.
    request?.assertOpen();
    const lease = await this.lease(request);
    const { client } = lease;
    // The transaction's time starts once it has a connection: waiting for one is bounded by the acquire timeout and the request.
    let budget: ExecutionBudget;
    try {
      budget =
        request === undefined
          ? new ExecutionBudget(this.clock, 'transaction', this.deadlines.transactionTimeoutMs)
          : request.child('transaction', this.deadlines.transactionTimeoutMs);
    } catch (error) {
      // The request was finished while this waited for its connection: nothing was sent on it, so it goes back as it came.
      lease.release();
      throw error;
    }

    let open = true;
    // Set while a piece of code holds the transaction exclusively (transaction-gate.ts): the scope probe, whose record is
    // readable to its own statement only. While it is set the transaction's own handle sends nothing.
    let holder: object | undefined;
    // What the transaction is doing, and the budget's expiry if it came: set in the expiry listener, before anything else runs.
    const run: {
      phase: Phase;
      /** True once BEGIN has been sent: before that there is no transaction to roll back. */
      sentBegin: boolean;
      expiry: { readonly error: BudgetExpiredError; readonly phase: Phase } | undefined;
    } = { phase: 'beginning', sentBegin: false, expiry: undefined };
    let inFlight = 0;
    // The statements the work has issued (not BEGIN, COMMIT or ROLLBACK), and how many of them were the security context.
    let issued = 0;
    let contextStatements = 0;
    let appliedContext: SecurityContext | undefined;
    // The first statement of the work that the server refused. A transaction that has had one is aborted whatever the work does
    // next, and its COMMIT is answered with ROLLBACK: this is the cause that error carries.
    let firstStatementFailure: unknown;
    const sendStatement = (...args: unknown[]): Promise<unknown> => {
      issued += 1;
      return send(...args).catch((error: unknown) => {
        firstStatementFailure ??= error;
        throw error;
      });
    };
    const send = async (...args: unknown[]): Promise<unknown> => {
      inFlight += 1;
      try {
        return await (client.query as (...forwarded: unknown[]) => Promise<unknown>)(...args);
      } finally {
        inFlight -= 1;
      }
    };
    const ended = () =>
      Promise.reject(new Error('The transaction has ended: its connection is no longer its own'));
    // Nothing reaches the connection once the budget has run out, or once the request above it is over (answered, or the client
    // left): the work may still be running, the connection is not its own, and nobody is waiting for what it would do.
    const refused = (): Promise<never> | undefined => {
      const gone = budget.expiredWith;
      if (gone !== undefined) return Promise.reject(gone);
      if (!open) return ended();
      try {
        budget.assertOpen();
      } catch (closed) {
        return Promise.reject(asError(closed));
      }
      return undefined;
    };
    // Only `query` is what the transaction needs of a connection, and only while the transaction is open and not held.
    const guarded = {
      query: (...args: unknown[]) => {
        const refusal = refused();
        if (refusal !== undefined) return refusal;
        if (holder !== undefined) {
          return Promise.reject(
            new Error(
              'A scope probe is running in this transaction: no other statement may use it until the probe ends',
            ),
          );
        }
        return sendStatement(...args);
      },
    };

    const expiring = new Promise<never>((_resolve, reject) => {
      budget.onExpiry((error) => {
        run.expiry = { error, phase: run.phase };
        reject(error);
      });
    });
    let destroyBecause: Error | undefined;

    const body = (async (): Promise<T> => {
      // A request that ran out, or was over, while this was getting its connection sends nothing at all.
      budget.assertOpen();
      // One round trip: BEGIN, and the server's own bound on the transaction. It is the budget plus the disposal bound, so the
      // server ends a transaction by itself only when this process could not clean up in time.
      const serverBound = Math.ceil(budget.remainingMilliseconds()) + DISPOSAL_BOUND_MS;
      run.sentBegin = true;
      await send(
        `begin; select set_config('transaction_timeout', '${String(serverBound)}ms', true)`,
      );
      run.phase = 'working';
      const tx: DatabaseTransaction = drizzle(guarded as never);
      registerTransactionFacts(tx, {
        statementsSinceContext: () => issued - contextStatements,
        markContextApplied: (context) => {
          contextStatements = issued;
          appliedContext = context;
        },
        appliedContext: () => appliedContext,
      });
      registerExclusiveGate(tx, async (exclusiveWork) => {
        if (holder !== undefined) {
          throw new Error('A scope probe is already running in this transaction');
        }
        // Taken before anything is awaited, so that a statement issued after the call is issued while it is held.
        const mine = {};
        holder = mine;
        const exclusive: DatabaseTransaction = drizzle({
          query: (...args: unknown[]) => {
            const refusal = refused();
            if (refusal !== undefined) return refusal;
            if (holder !== mine) {
              return Promise.reject(
                new Error('The scope probe has ended: this handle is no longer its own'),
              );
            }
            return sendStatement(...args);
          },
        } as never);
        try {
          return await exclusiveWork(exclusive);
        } finally {
          holder = undefined;
        }
      });
      // The work runs under the transaction's budget, so what it starts (an effect, a nested wait) is bounded by it too.
      let result: T;
      try {
        result = await runWithBudget(budget, () => openTransaction.run(true, () => work(tx)));
      } finally {
        // The work has returned or thrown, and from this moment the handle it was given sends nothing: a statement that a
        // continuation it left behind sends while the commit or the rollback is in flight would queue behind it and run on
        // the connection with no transaction and no context, which may be a connection that goes back to the pool.
        open = false;
      }
      // Work that finished after the budget ran out is never committed. Its lateness is logged: the caller was told it failed.
      const late = budget.expiredWith;
      if (late !== undefined) {
        this.logger.warn(
          { label: late.label },
          'database work finished after its budget ran out; nothing it did was committed',
        );
        throw late;
      }
      // A request that is over (answered, or the client left) has nobody waiting for what this did: it is rolled back, not committed.
      // A statement already running is not cancelled by this (finishing is not expiry; the transaction's own bound still ends it).
      if (budget.closed) {
        this.logger.warn(
          {},
          'database work finished after its request was over; nothing it did was committed',
        );
        budget.assertOpen();
      }
      run.phase = 'committing';
      let completion: unknown;
      try {
        completion = await send('commit');
      } catch (error) {
        // An answer from the server that is an error: it did not commit. Anything else (the session ended, no answer): unknown.
        throw isDefiniteRefusal(error)
          ? error
          : new CommitOutcomeUnknownError('connection-lost', { cause: error });
      }
      // The answer is read outside the handler above, so that what it says is never taken for a lost connection. A COMMIT of a
      // transaction that has failed is not an error: the server completes it with the tag ROLLBACK and keeps nothing.
      const tag = commandTagOf(completion);
      if (tag === 'COMMIT') return result;
      if (tag === 'ROLLBACK') {
        throw new TransactionRolledBackError(
          firstStatementFailure === undefined ? {} : { cause: firstStatementFailure },
        );
      }
      // Anything else (no result, no tag, another statement's tag) says nothing about the commit, and is never success.
      throw new CommitOutcomeUnknownError('unrecognized-completion', {
        cause: new Error(
          'COMMIT was answered with ' + (tag === undefined ? 'no command tag' : 'the tag ' + tag),
        ),
      });
    })();

    try {
      return await Promise.race([body, expiring]);
    } catch (error) {
      const expiry = run.expiry;
      if (expiry !== undefined && error === expiry.error) {
        // Whatever the work does from here is dropped, and nothing it does reaches the connection.
        if (expiry.phase === 'committing') {
          // The commit was sent and not answered: it may have happened. No rollback is sent and none is claimed.
          destroyBecause = new CommitOutcomeUnknownError('budget-expired', { cause: error });
          this.logger.error(
            { label: expiry.error.label, phase: expiry.phase },
            'database commit outcome unknown: the budget ran out while the commit was in flight',
          );
          throw destroyBecause;
        }
        destroyBecause = expiry.error;
        const disposal = await this.dispose(client, {
          statementRunning: inFlight > 0,
          began: run.sentBegin,
        });
        this.logger.warn(
          {
            label: expiry.error.label,
            budgetMilliseconds: expiry.error.budgetMilliseconds,
            phase: expiry.phase,
            cancel: disposal.cancel,
            rolledBack: disposal.rolledBack,
            began: run.sentBegin,
          },
          'database transaction abandoned: its budget ran out',
        );
        throw error;
      }
      if (
        error instanceof CommitOutcomeUnknownError ||
        error instanceof TransactionRolledBackError
      ) {
        // Unknown: no rollback is sent and none is claimed. Rolled back: the server already did it, so there is nothing to send.
        // Either way a transaction that failed at its commit is not trusted again.
        destroyBecause = error;
        throw error;
      }
      // The server may have ended the session just before (the idle-in-transaction timeout is raised on the connection, and the
      // next statement only finds it closed).
      const deadline = deadlineFrom(error) ?? deadlineFrom(lease.connectionError(), error);
      // A connection that could not begin is not trusted again; one that did is rolled back, and is trusted
      // again only if the rollback worked, the commit was not what failed, and no time bound of the server's ended its work.
      const rollbackFailure =
        run.phase === 'beginning' ? undefined : await this.rollBackWithinBound(client);
      destroyBecause =
        rollbackFailure ??
        (run.phase === 'working' ? undefined : asError(error)) ??
        (deadline === undefined ? undefined : asError(error));
      throw closedIn(error) ?? deadline ?? error;
    } finally {
      open = false;
      budget.finish();
      lease.release(destroyBecause);
    }
  }

  /**
   * Takes a permit and a connection under **one deadline**: the acquire timeout, or what the enclosing budget (the request's, or
   * the readiness probe's) has left if that is less, measured on the monotonic clock from the moment this is called. The wait for
   * a permit and the connection itself both draw on it, and neither is given a fresh one when the other ends. When it passes,
   * the wait ends (the waiter is taken out of the line, so a connection that comes free is never handed to a caller that has
   * gone) and so does the connect. A deadline of the acquire timeout's own is `AcquireTimeoutError`; one of the enclosing
   * budget's is that budget's error.
   */
  private async lease(enclosing: ExecutionBudget | undefined): Promise<Lease> {
    const acquisition =
      enclosing === undefined
        ? new ExecutionBudget(this.clock, 'acquisition', this.deadlines.acquireTimeoutMs)
        : enclosing.child('acquisition', this.deadlines.acquireTimeoutMs);
    try {
      return await this.acquireWithin(acquisition);
    } catch (error) {
      if (error instanceof BudgetExpiredError && error.label === 'acquisition') {
        throw new AcquireTimeoutError(this.deadlines.acquireTimeoutMs);
      }
      throw error;
    } finally {
      acquisition.finish();
    }
  }

  private async acquireWithin(acquisition: ExecutionBudget): Promise<Lease> {
    const permit = await this.queue.acquire({
      // The deadline is the acquisition budget's, which ends the wait through the signal; this is only the most a wait can be.
      timeoutMilliseconds: this.deadlines.acquireTimeoutMs,
      signal: acquisition.signal,
    });
    // A permit can come free at the very moment the deadline passes: then no connection is started for a caller already refused.
    const lateForPermit = acquisition.expiredWith;
    if (lateForPermit !== undefined) {
      permit.release();
      throw lateForPermit;
    }
    const connecting = this.pool.connect();
    let client: PoolClient;
    try {
      client = await untilExpired(connecting, acquisition);
    } catch (error) {
      // A connection may still be being made. The permit stays held until the attempt ends, so that there are never more
      // permits out than connections, and a connection that arrives late goes back to the pool unused.
      connecting
        .then(
          (late) => {
            late.release();
          },
          () => undefined,
        )
        .finally(() => {
          permit.release();
        });
      throw error;
    }
    // A connection that arrives after the deadline (before the timer that enforces it has run) is not handed to a caller that was
    // owed a failure: nothing was sent on it, so it goes back as it came.
    const lateForConnection = acquisition.expiredWith;
    if (lateForConnection !== undefined) {
      client.release();
      permit.release();
      throw lateForConnection;
    }

    // The first error the connection raised, except that the server's own explanation of why it ended the session (the FATAL
    // error) is kept over the driver's "connection terminated" that follows it.
    let raised: Error | undefined;
    const onError = (error: Error): void => {
      if (
        raised === undefined ||
        (serverErrorIn(raised) === undefined && serverErrorIn(error) !== undefined)
      ) {
        raised = error;
      }
    };
    client.on('error', onError);
    let released = false;
    return {
      client,
      connectionError: () => raised,
      release: (error) => {
        if (released) return;
        released = true;
        client.off('error', onError);
        client.release(error ?? raised);
        permit.release();
      },
    };
  }

  /**
   * After an expiry: cancel the statement that is running (from another connection, so it does not wait behind it), then roll
   * back. It never takes longer than `DISPOSAL_BOUND_MS`; the caller destroys the connection whatever came of it.
   */
  private async dispose(
    client: PoolClient,
    state: { readonly statementRunning: boolean; readonly began: boolean },
  ): Promise<{ cancel: CancelOutcome | 'none-running' | 'unnamed'; rolledBack: boolean }> {
    const progress: { cancel: CancelOutcome | 'none-running' | 'unnamed'; rolledBack: boolean } = {
      cancel: 'none-running',
      rolledBack: false,
    };
    // One budget for the whole clean-up: the cancel and the rollback draw on it together, and neither is given a fresh one.
    const disposal = new ExecutionBudget(this.clock, 'disposal', DISPOSAL_BOUND_MS);
    try {
      const over = new Promise<void>((resolve) => {
        disposal.onExpiry(() => {
          resolve();
        });
      });
      const sequence = (async () => {
        if (state.statementRunning) {
          const processId = processIdOf(client);
          progress.cancel =
            processId === undefined ? 'unnamed' : await this.canceller.cancel(processId);
        }
        // The bound may have passed while the cancel was being made: the caller destroys the connection at that moment, and
        // nothing more is sent on it.
        if (disposal.expired) return;
        // Nothing was begun, nothing to roll back; nothing is claimed.
        if (state.began) progress.rolledBack = (await this.rollBack(client)) === undefined;
      })();
      sequence.catch(() => undefined);
      await Promise.race([sequence, over]);
      return { ...progress };
    } finally {
      disposal.finish();
    }
  }

  /** The rollback of an ordinary failure, bounded like the one after an expiry: a connection that does not answer is destroyed. */
  private async rollBackWithinBound(client: PoolClient): Promise<Error | undefined> {
    const within = await withinBudget(this.rollBack(client), DISPOSAL_BOUND_MS);
    if (!within.expired) return within.value;
    this.logger.error({}, 'database transaction rollback did not finish within its bound');
    return new Error('the rollback did not finish within its bound');
  }

  /** Rolls the transaction back. Resolves to why the connection must not be reused, when it must not. */
  private async rollBack(client: PoolClient): Promise<Error | undefined> {
    try {
      await client.query('rollback');
      return undefined;
    } catch (error) {
      this.logger.error({ err: error }, 'database transaction could not be rolled back');
      return error instanceof Error ? error : new Error('rollback failed');
    }
  }

  /**
   * Rejects unless the database answers and the connection runs as a safe runtime identity. It takes a permit and a connection
   * like any other caller, so it waits in the same bounded line and cannot over-commit the pool.
   *
   * **It is bounded on this side.** The whole probe (the wait for a permit, the connection and the query) draws on one deadline,
   * `options.timeoutMs` (the readiness registry's, which is also how long the registry waits). When it passes, the probe fails,
   * its connection is destroyed rather than returned to the pool, and its permit is given back, so probes that the database does
   * not answer cannot take the pool that serves the business. The server's own statement timeout is a second bound, not the
   * first. Nothing is sent to cancel the query: it is a catalogue lookup, and the destroyed connection and that timeout end it.
   */
  async check(options?: ReadinessCheckOptions): Promise<void> {
    const budget = new ExecutionBudget(
      this.clock,
      'readiness',
      options?.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    );
    try {
      await this.probe(budget);
    } finally {
      budget.finish();
    }
  }

  private async probe(budget: ExecutionBudget): Promise<void> {
    // The login the pool connects as, whichever it is: the API runtime, a worker or the provisioning identity. What a
    // runtime login may not be or hold is role-posture.ts's to say, and the catalogue check asks the same question of the
    // named logins, so the two agree.
    const lease = await this.lease(budget);
    let failure: Error | undefined;
    let posture: ({ role: string } & Record<string, unknown>) | undefined;
    try {
      const result = await untilExpired(
        lease.client.query<{ role: string } & Record<string, unknown>>(
          ROLE_POSTURE_SQL,
          rolePostureParameters(null),
        ),
        budget,
      );
      posture = result.rows[0];
    } catch (error) {
      failure = asError(error);
      throw error;
    } finally {
      lease.release(failure);
    }
    if (posture === undefined)
      throw new Error('the connected database role could not be inspected');

    const unsafe = unsafeFlags(posture);
    if (unsafe.length === 0) return;
    if (!this.reportedUnsafeRole) {
      this.reportedUnsafeRole = true;
      this.logger.error(
        { role: posture.role, flags: unsafe },
        'database role is not a safe runtime identity',
      );
    }
    throw new Error('the database role is not a safe runtime identity');
  }

  /** Ends the pool once. Waiters are rejected; waits for connections in use to be released. */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.queue.close();
    await this.pool.end();
  }
}
