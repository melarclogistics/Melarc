import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { DATABASE_POOL, LOGGER } from '../platform.tokens.js';
import { capabilityPermittedFor } from './capability-access.js';
import { ROLE_POSTURE_SQL, rolePostureParameters, unsafeFlags } from './role-posture.js';
import { registerExclusiveGate } from './transaction-gate.js';
import {
  SecurityContextError,
  toContextSettings,
  type SecurityContext,
} from './transaction-context.js';

/**
 * What the work inside a transaction receives: queries on the one connection the transaction holds. It cannot open
 * a transaction of its own: the one it runs in is the only one there is, and it ends when the work does.
 */
export type DatabaseTransaction = Omit<NodePgDatabase, 'transaction'>;

/** Set while a transaction's work runs, so that a transaction opened inside it is seen for what it is. */
const openTransaction = new AsyncLocalStorage<true>();

/**
 * The API's one door to PostgreSQL: a lazily connecting pool, readiness, shutdown and transactions.
 *
 * Protected work belongs in `transactionWithContext`, which opens a transaction and sets the security
 * context transaction-locally, so it is discarded at commit or rollback and can never persist on a pooled
 * connection (SECURITY_DESIGN.md §14.1). There is deliberately no way to set session-level state, and the pool,
 * the driver handle and a transaction without a context are not exposed.
 */
@Injectable()
export class DatabaseService {
  private ended = false;
  private reportedUnsafeRole = false;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
    shutdown: ShutdownRegistry,
    readiness: ReadinessRegistry,
  ) {
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
    readiness.register({ name: 'database', check: () => this.check() });
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
    return this.runInTransaction(async (tx) => {
      const assignments = settings.map(([name, value]) => sql`set_config(${name}, ${value}, true)`);
      // The role comes back from the statement that sets the context: it is what the database says this connection
      // runs as, and a SYSTEM capability is opened only over the identity that holds its grants (§14.1b).
      const applied = await tx.execute(
        sql`select ${sql.join(assignments, sql`, `)}, current_user as database_role`,
      );
      const capability = context.taskCapability;
      if (
        context.principalType === 'SYSTEM' &&
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
   * A connection that failed to begin, to roll back or to commit is destroyed and not reused. The transaction
   * object stops working when the transaction ends. A transaction opened inside another is refused: it would hold a
   * second connection while the first is held, and as many such requests as the pool has connections wait for each
   * other for ever.
   */
  private async runInTransaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    if (openTransaction.getStore() === true) {
      throw new Error(
        'A transaction is already open in this request: do the work in it, a second one would hold a second connection',
      );
    }

    const client = await this.pool.connect();
    let open = true;
    // Set while a piece of code holds the transaction exclusively (transaction-gate.ts): the scope probe, whose record is
    // readable to its own statement only. While it is set the transaction's own handle sends nothing.
    let holder: object | undefined;
    const send = (...args: unknown[]) =>
      (client.query as (...forwarded: unknown[]) => Promise<unknown>)(...args);
    const ended = () =>
      Promise.reject(new Error('The transaction has ended: its connection is no longer its own'));
    // Only `query` is what the transaction needs of a connection, and only while the transaction is open and not held.
    const guarded = {
      query: (...args: unknown[]) => {
        if (!open) return ended();
        if (holder !== undefined) {
          return Promise.reject(
            new Error(
              'A scope probe is running in this transaction: no other statement may use it until the probe ends',
            ),
          );
        }
        return send(...args);
      },
    };
    let destroyBecause: Error | undefined;
    let began = false;
    try {
      await client.query('begin');
      began = true;
      const tx: DatabaseTransaction = drizzle(guarded as never);
      registerExclusiveGate(tx, async (exclusiveWork) => {
        if (holder !== undefined) {
          throw new Error('A scope probe is already running in this transaction');
        }
        // Taken before anything is awaited, so that a statement issued after the call is issued while it is held.
        const mine = {};
        holder = mine;
        const exclusive: DatabaseTransaction = drizzle({
          query: (...args: unknown[]) => {
            if (!open) return ended();
            if (holder !== mine) {
              return Promise.reject(
                new Error('The scope probe has ended: this handle is no longer its own'),
              );
            }
            return send(...args);
          },
        } as never);
        try {
          return await exclusiveWork(exclusive);
        } finally {
          holder = undefined;
        }
      });
      const result = await openTransaction.run(true, () => work(tx));
      await client.query('commit');
      return result;
    } catch (error) {
      // A connection that could not begin is not trusted again; one that did is rolled back, and is trusted
      // again only if the rollback worked.
      destroyBecause = began
        ? await this.rollBack(client)
        : error instanceof Error
          ? error
          : new Error('begin failed');
      throw error;
    } finally {
      open = false;
      client.release(destroyBecause);
    }
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
   * Rejects unless the database answers and the connection runs as a safe runtime identity. It sets no
   * timeout of its own: the readiness registry stops waiting for a slow check after its own deadline.
   */
  async check(): Promise<void> {
    // The login the pool connects as, whichever it is: the API runtime, a worker or the provisioning identity. What a
    // runtime login may not be or hold is role-posture.ts's to say, and the catalogue check asks the same question of the
    // named logins, so the two agree.
    const result = await this.pool.query<{ role: string } & Record<string, unknown>>(
      ROLE_POSTURE_SQL,
      rolePostureParameters(null),
    );
    const posture = result.rows[0];
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

  /** Ends the pool once. Waits for connections in use to be released. */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.pool.end();
  }
}
