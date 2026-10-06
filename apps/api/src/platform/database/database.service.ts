import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { DATABASE_POOL, LOGGER } from '../platform.tokens.js';
import { toContextSettings, type SecurityContext } from './transaction-context.js';

/** What the work inside a transaction receives. */
export type DatabaseTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/**
 * Facts about the role this connection runs as. A runtime identity may hold none of them
 * (SECURITY_DESIGN.md §14.6): superuser, BYPASSRLS, creating databases or roles, owning the database or
 * owning a table, view, sequence or index. Each makes row-level security either bypassable or removable by the
 * connection. Not inspected yet: owning a schema or function, and CREATE on a schema or the database (the
 * "schema modification" of §14.6); provisioning and the migrations are what keep those from being granted.
 *
 * Owning includes owning through membership: a role that is a member of the owner has the owner's powers
 * (it can alter or drop a table's policies), so it counts as the owner. `pg_has_role(.., 'MEMBER')` is true
 * for the role itself and for any role it belongs to, directly or indirectly.
 */
const ROLE_POSTURE_SQL = `
  SELECT r.rolname AS role,
         r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
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
  readonly owns_database: boolean;
  readonly owns_objects: boolean;
}

const UNSAFE_FLAGS = [
  'rolsuper',
  'rolbypassrls',
  'rolcreatedb',
  'rolcreaterole',
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
    return this.db.transaction(work);
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
    return this.db.transaction(async (tx) => {
      const assignments = settings.map(([name, value]) => sql`set_config(${name}, ${value}, true)`);
      await tx.execute(sql`select ${sql.join(assignments, sql`, `)}`);
      return work(tx);
    });
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
