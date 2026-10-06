import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { DATABASE_POOL, LOGGER } from '../platform.tokens.js';
import { toContextSettings, type SecurityContext } from './transaction-context.js';

/**
 * What the work inside a transaction receives: queries on the one connection the transaction holds. It cannot open
 * a transaction of its own: the one it runs in is the only one there is, and it ends when the work does.
 */
export type DatabaseTransaction = Omit<NodePgDatabase, 'transaction'>;

/** Set while a transaction's work runs, so that a transaction opened inside it is seen for what it is. */
const openTransaction = new AsyncLocalStorage<true>();

/**
 * Facts about the role this connection runs as. A runtime identity may hold none of them
 * (SECURITY_DESIGN.md §14.6): superuser, BYPASSRLS, creating databases or roles, replication, owning the database
 * or owning a table, view, sequence or index, a predefined role (`pg_*`: each is power that no runtime identity
 * needs), or a `melarc.*` setting stored on the role or the database, which would be a security context that no
 * transaction set. Each makes row-level security either bypassable or removable by the connection, or the context
 * that it reads not the application's to decide. Not inspected yet: owning a schema or function, and CREATE on a schema or the database (the
 * "schema modification" of §14.6); provisioning and the migrations are what keep those from being granted.
 *
 * Owning includes owning through membership: a role that is a member of the owner has the owner's powers
 * (it can alter or drop a table's policies), so it counts as the owner. `pg_has_role(.., 'MEMBER')` is true
 * for the role itself and for any role it belongs to, directly or indirectly.
 */
const ROLE_POSTURE_SQL = `
  SELECT r.rolname AS role,
         r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
         EXISTS (SELECT 1 FROM pg_roles p
                  WHERE p.rolname LIKE 'pg\\_%' AND p.rolname <> 'pg_database_owner'
                    AND pg_has_role(r.oid, p.oid, 'MEMBER')) AS has_predefined_role,
         EXISTS (SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) AS setting
                  WHERE s.setrole IN (r.oid, 0)
                    AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                    AND setting LIKE 'melarc.%') AS has_stored_context,
         EXISTS (SELECT 1 FROM pg_database d
                  WHERE d.datname = current_database()
                    AND pg_has_role(r.oid, d.datdba, 'MEMBER')) AS owns_database,
         EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE pg_has_role(r.oid, c.relowner, 'MEMBER')
                    AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema') AS owns_objects
    FROM pg_roles r
   WHERE r.rolname = current_user`;

interface RolePosture {
  readonly role: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
  readonly has_predefined_role: boolean;
  readonly has_stored_context: boolean;
  readonly owns_database: boolean;
  readonly owns_objects: boolean;
}

const UNSAFE_FLAGS = [
  'rolsuper',
  'rolbypassrls',
  'rolcreatedb',
  'rolcreaterole',
  'rolreplication',
  'has_predefined_role',
  'has_stored_context',
  'owns_database',
  'owns_objects',
] as const;

/**
 * The API's one door to PostgreSQL: a lazily connecting pool, readiness, shutdown and transactions.
 *
 * Protected work belongs in `transactionWithContext`, which opens a transaction and sets the security
 * context transaction-locally, so it is discarded at commit or rollback and can never persist on a pooled
 * connection (SECURITY_DESIGN.md §14.1). There is deliberately no way to set session-level state.
 */
@Injectable()
export class DatabaseService {
  readonly db: NodePgDatabase;
  private ended = false;
  private reportedUnsafeRole = false;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
    shutdown: ShutdownRegistry,
    readiness: ReadinessRegistry,
  ) {
    this.db = drizzle(pool);
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

  /** A transaction with no principal context: protected tables answer nothing to it. */
  transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.runInTransaction(work);
  }

  /**
   * A transaction whose security context is set before the work runs. An invalid context is refused
   * before a connection is taken, so nothing reaches the pool (§14.1b).
   */
  async transactionWithContext<T>(
    context: SecurityContext,
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const settings = toContextSettings(context);
    return this.runInTransaction(async (tx) => {
      const assignments = settings.map(([name, value]) => sql`set_config(${name}, ${value}, true)`);
      await tx.execute(sql`select ${sql.join(assignments, sql`, `)}`);
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
    // Only `query` is what the transaction needs of a connection, and only while the transaction is open.
    const guarded = {
      query: (...args: unknown[]) =>
        open
          ? (client.query as (...forwarded: unknown[]) => Promise<unknown>)(...args)
          : Promise.reject(
              new Error('The transaction has ended: its connection is no longer its own'),
            ),
    };
    let destroyBecause: Error | undefined;
    let began = false;
    try {
      await client.query('begin');
      began = true;
      const tx = drizzle(guarded as never);
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
    const result = await this.pool.query<RolePosture>(ROLE_POSTURE_SQL);
    const posture = result.rows[0];
    if (posture === undefined)
      throw new Error('the connected database role could not be inspected');

    const unsafe = UNSAFE_FLAGS.filter((flag) => posture[flag]);
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
