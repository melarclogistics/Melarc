import type pg from 'pg';

import { clientFor, type TestDatabase } from './test-database.js';

/**
 * The kit's `observe()` (S0.10): a second connection that reads. What the application did is asserted from here, on a connection
 * the application's pool does not own, so a test sees committed state (not the half-finished state of a transaction it is inside)
 * and cannot be fooled by the application's own view of its work: a refusal is shown by the rows that did not change.
 *
 * It connects as the cluster administrator, so row-level security hides nothing from it, and the session is read-only at the
 * server (`default_transaction_read_only`): it has no way to write, and a statement that tries is refused (`25006`). It reads
 * the same tables `admin()` arranges. Test support.
 */

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a plain table or column name`);
  return `"${name}"`;
}

export class Observer {
  constructor(private readonly client: pg.Client) {}

  async rows<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.client.query<T>(text, values)).rows;
  }

  /** The first row, or `undefined`. */
  async one<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.rows<T>(text, values))[0];
  }

  /** The rows of `table` that match every column = value pair. */
  async count(table: string, match: Readonly<Record<string, unknown>> = {}): Promise<number> {
    const entries = Object.entries(match);
    const filter =
      entries.length === 0
        ? ''
        : ` where ${entries.map(([column], at) => `${identifier(column)} = $${String(at + 1)}`).join(' and ')}`;
    const row = await this.one<{ n: number }>(
      `select count(*)::int as n from ${identifier(table)}${filter}`,
      entries.map(([, value]) => value),
    );
    return row?.n ?? 0;
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export async function observe(database: TestDatabase): Promise<Observer> {
  const client = clientFor(database.urlFor('postgres'), {
    connectionTimeoutMillis: 5_000,
    options: '-c default_transaction_read_only=on',
  });
  client.on('error', () => undefined);
  await client.connect();
  return new Observer(client);
}
