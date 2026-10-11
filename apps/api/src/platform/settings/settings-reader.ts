import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { transactionOf } from '../database/transaction-handle.js';

/**
 * The value types of a setting (the table's `setting_value_type_closed`, domain-model.md §3). A setting is stored as JSON, and
 * nothing in the database ties the JSON to the declared type (obligation OB-86), so the reader does.
 */
export const SETTING_TYPES = ['integer', 'decimal', 'boolean', 'string', 'list', 'object'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export type SettingScope = 'COMPANY' | 'PLATFORM';

/** `SETTING_MISSING`: "a required setting has no approved value. Fails visibly: the system never borrows a default" (errors-and-enums.md). */
export class SettingMissingError extends Error {
  readonly code = 'SETTING_MISSING';
  constructor(readonly key: string) {
    super(`The setting ${key} has no approved value`);
    this.name = 'SettingMissingError';
  }
}

/** `SETTING_INVALID`: "a setting exists but fails validation. Fails safely and alerts administrators". The message never holds the value. */
export class SettingInvalidError extends Error {
  readonly code = 'SETTING_INVALID';
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`The setting ${key} is not valid: ${reason}`);
    this.name = 'SettingInvalidError';
  }
}

/** A row of `setting` as the reader asks for it. */
export interface SettingRow {
  readonly key: string;
  readonly scope: SettingScope;
  readonly value_type: SettingType;
  readonly value: unknown;
  readonly unit: string;
}

export interface SettingValue {
  readonly key: string;
  readonly scope: SettingScope;
  readonly type: SettingType;
  readonly value: unknown;
  readonly unit: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const FITS: Readonly<Record<SettingType, (value: unknown) => boolean>> = {
  integer: (value) => typeof value === 'number' && Number.isSafeInteger(value),
  decimal: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  string: (value) => typeof value === 'string',
  list: (value) => Array.isArray(value),
  object: isPlainObject,
};

/**
 * What a stored row means, or the refusal. Pure: no database. A missing row is `SETTING_MISSING`, never a default of any kind; a
 * row whose JSON is not of its declared type, or that is not of the type the caller asked for, is `SETTING_INVALID`.
 */
export function interpretSetting(
  key: string,
  row: SettingRow | undefined,
  expected?: SettingType,
): SettingValue {
  if (row === undefined) throw new SettingMissingError(key);
  const fits = (SETTING_TYPES as readonly string[]).includes(row.value_type)
    ? FITS[row.value_type]
    : undefined;
  if (fits === undefined) throw new SettingInvalidError(key, 'its type is not a known type');
  if (!fits(row.value))
    throw new SettingInvalidError(key, `its value is not of its type ${row.value_type}`);
  if (expected !== undefined && expected !== row.value_type) {
    throw new SettingInvalidError(key, `it is a ${row.value_type} and a ${expected} was asked for`);
  }
  return {
    key: row.key,
    scope: row.scope,
    type: row.value_type,
    value: row.value,
    unit: row.unit,
  };
}

const KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The typed reader over `setting` (S0.13; settings.md; MIGRATION_AND_SEEDING.md §4). It reads in the **caller's transaction**,
 * through the handle, under the caller's security context, so it sees what that context may see: a staff context and the
 * `authentication` capability read the table (migration 0003), and every other context sees no row, which reads as missing.
 *
 * **There are no defaults.** A key with no row is `SETTING_MISSING`; the code that reads a setting never supplies a value of its
 * own, a value from another scope or a value that "worked before". The settings the documents leave open are not seeded
 * (OB-78) and so are missing until a decision supplies them. `SETTING_MISSING` is for pricing and configuration paths: it never
 * blocks an operational or custody decision (errors-and-enums.md), and it is the caller's to decide which a read is.
 *
 * A value is returned in its declared type (`integer` is a safe integer, `decimal` a finite number, `list` an array, `object` a plain
 * object), or the read fails as `SETTING_INVALID`, which fails safely. The hub-scoped values (`HubSetting`) do not exist yet.
 */
export class SettingsReader {
  async get(transaction: TransactionHandle, key: string): Promise<SettingValue> {
    return this.read(transaction, key);
  }

  async integer(transaction: TransactionHandle, key: string): Promise<number> {
    return (await this.read(transaction, key, 'integer')).value as number;
  }

  async decimal(transaction: TransactionHandle, key: string): Promise<number> {
    return (await this.read(transaction, key, 'decimal')).value as number;
  }

  async boolean(transaction: TransactionHandle, key: string): Promise<boolean> {
    return (await this.read(transaction, key, 'boolean')).value as boolean;
  }

  async string(transaction: TransactionHandle, key: string): Promise<string> {
    return (await this.read(transaction, key, 'string')).value as string;
  }

  async list(transaction: TransactionHandle, key: string): Promise<readonly unknown[]> {
    return (await this.read(transaction, key, 'list')).value as readonly unknown[];
  }

  async object(
    transaction: TransactionHandle,
    key: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return (await this.read(transaction, key, 'object')).value as Readonly<Record<string, unknown>>;
  }

  private async read(
    transaction: TransactionHandle,
    key: string,
    expected?: SettingType,
  ): Promise<SettingValue> {
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new TypeError('A setting key is a plain name');
    }
    const result = await transactionOf(transaction).execute(
      sql`select key, scope, value_type, value, unit from setting where key = ${key}`,
    );
    return interpretSetting(key, result.rows[0] as unknown as SettingRow | undefined, expected);
  }
}
