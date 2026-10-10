import type pg from 'pg';

import { closeEach } from '../../../src/test-support/cleanup.js';
import { clientFor, type TestDatabase } from './test-database.js';

/**
 * The kit's `admin()` (S0.10): the cluster administrator's hands on a test's database, for the things a test must do to the data
 * that no operation of the application will ever do. It ages a row (so that an expiry is reached by changing the data and not by
 * waiting), changes a status or a column, and breaks writes to a table (so that a failure in the middle of an operation can be
 * shown to leave nothing behind). It connects as the administrator, who bypasses row-level security: it is for arranging a test,
 * never for what a test then asserts about the application, which is read from `observe()`.
 *
 * Table and column names are checked against a plain identifier and quoted; every value is a parameter. It is test support and
 * works on the disposable database it is given, which the kit's own tests make and drop.
 */

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a plain table or column name`);
  return `"${name}"`;
}

/** Column = value, all of them true: which rows an arrangement reaches. An empty match reaches every row. */
export type RowMatch = Readonly<Record<string, unknown>>;

function where(match: RowMatch, first: number): { text: string; values: unknown[] } {
  const entries = Object.entries(match);
  if (entries.length === 0) return { text: '', values: [] };
  return {
    text: ` where ${entries.map(([column], at) => `${identifier(column)} = $${String(first + at)}`).join(' and ')}`,
    values: entries.map(([, value]) => value),
  };
}

const BREAK_FUNCTION = 'melarc_kit_break_writes';

export class Admin {
  private readonly broken = new Set<string>();

  constructor(private readonly client: pg.Client) {}

  /** Rows of any statement. */
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.client.query<T>(text, values)).rows;
  }

  /**
   * Moves a timestamp column back in time by `interval` (PostgreSQL interval text: `'2 days'`, `'31 minutes'`) for the rows
   * `match` reaches, and returns how many that was. A row "created two days ago" is then one the application sees as old, by the
   * database's own clock, which is the clock a persisted expiry is judged by.
   */
  async ageRows(
    table: string,
    column: string,
    interval: string,
    match: RowMatch = {},
  ): Promise<number> {
    const filter = where(match, 2);
    const result = await this.client.query(
      `update ${identifier(table)} set ${identifier(column)} = ${identifier(column)} - $1::interval${filter.text}`,
      [interval, ...filter.values],
    );
    return result.rowCount ?? 0;
  }

  /** Sets a column (a status, a flag, a count) on the rows `match` reaches, and returns how many that was. */
  async setColumn(
    table: string,
    column: string,
    value: unknown,
    match: RowMatch = {},
  ): Promise<number> {
    const filter = where(match, 2);
    const result = await this.client.query(
      `update ${identifier(table)} set ${identifier(column)} = $1${filter.text}`,
      [value, ...filter.values],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Makes every insert, update and delete on `table` fail with `P0001` ("write refused by the test kit"), whoever makes it. The
   * returned function mends the table; `close()` mends any table left broken. A write that fails in the middle of an operation is
   * how a test shows that the operation left nothing behind.
   */
  async breakWrites(table: string): Promise<{ mend: () => Promise<void> }> {
    const quoted = identifier(table);
    await this.client.query(
      `create or replace function public.${BREAK_FUNCTION}() returns trigger language plpgsql as $$
       begin raise exception 'write refused by the test kit' using errcode = 'P0001'; end $$`,
    );
    await this.client.query(
      `create trigger ${identifier(`melarc_kit_break_${table}`)} before insert or update or delete on ${quoted}
         for each row execute function public.${BREAK_FUNCTION}()`,
    );
    this.broken.add(table);
    return { mend: () => this.mend(table) };
  }

  async mend(table: string): Promise<void> {
    if (!this.broken.has(table)) return;
    await this.client.query(
      `drop trigger if exists ${identifier(`melarc_kit_break_${table}`)} on ${identifier(table)}`,
    );
    this.broken.delete(table);
  }

  /**
   * Mends what is still broken and closes the connection. Every table is attempted and the connection is ended whatever the mends
   * did, so a table that cannot be mended does not leak the connection; the failures are reported together.
   */
  async close(): Promise<void> {
    await closeEach([
      ...[...this.broken].map((table) => ({
        name: `mend ${table}`,
        close: () => this.mend(table),
      })),
      { name: 'the connection', close: () => this.client.end() },
    ]);
  }
}

export async function openAdmin(database: TestDatabase): Promise<Admin> {
  const client = clientFor(database.urlFor('postgres'), { connectionTimeoutMillis: 5_000 });
  client.on('error', () => undefined);
  await client.connect();
  return new Admin(client);
}
