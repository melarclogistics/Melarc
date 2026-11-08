import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertNotification } from './support/notifications.js';
import { HUB_A, HUB_B } from './support/rls-fixture.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S1.23, the closed parameters of a notification (migration 0066; `notification.parameters`): what a message says beyond the code and the day of
 * the record it is about is kept as **tokens and never text**, so that no note, name, number or address can be stored in a table that the lane
 * writes, an operator reads and no export is allowed to leak. The table holds the rule itself, for every writer:
 *
 * - an object of at most four members, each a lower-case name with an upper-case token for its value;
 * - nothing else: not text with spaces or lower-case letters, not a number, a flag, a null, an array or a nested object, and not a name that
 *   is not a plain lower-case one;
 * - and the lane's login can write it when the notification is made and never change it afterwards.
 */
let database: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(
    `insert into hub (id, name) values ('${HUB_A}', 'Hub A'), ('${HUB_B}', 'Hub B')`,
  );
}, 120_000);

afterAll(async () => {
  await admin.end();
  await database.drop();
});

/** The notification the lane would make with these parameters: the SQLSTATE the table raises, or undefined when it keeps them. */
async function makes(parameters: unknown): Promise<string | undefined> {
  try {
    await insertNotification(admin, {
      hubId: HUB_A,
      subjectId: randomUUID(),
      messageKind: 'PICKUP_SKIPPED_VENDOR_FEED',
      audience: 'VENDOR_FEED',
      channel: 'FEED',
      state: 'DELIVERED',
      parameters,
    });
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('the parameters of a notification are closed tokens', () => {
  it('start as an empty object', async () => {
    const { id } = await insertNotification(admin, {
      hubId: HUB_A,
      subjectId: randomUUID(),
      messageKind: 'PICKUP_SKIPPED_VENDOR_FEED',
      audience: 'VENDOR_FEED',
      channel: 'FEED',
      state: 'DELIVERED',
    });
    const found = await admin.query<{ parameters: unknown }>(
      `select parameters from notification where id = $1`,
      [id],
    );
    expect(found.rows[0]?.parameters).toEqual({});
  });

  // Break caught: a check that refuses a document the lane writes for the notice of a skip.
  it.each([
    [{}],
    [{ reason: 'LOCATION_INACCESSIBLE' }],
    [{ reason: 'RUN_CUT_SHORT', action: 'NONE' }],
    [{ a: 'A', b: 'B', c: 'C', d: 'D' }],
    [{ reason: 'A'.repeat(64) }],
    [{ reason_code_2: 'STOP_RAISED_IN_ERROR' }],
  ])('keeps %j', async (parameters) => {
    expect(await makes(parameters)).toBeUndefined();
  });

  // Break caught: a value that could carry text, a number, an address, a list or an object; a fifth member; a name that is not a plain lower-case
  // one; or a document that is not an object, each of which would let the table keep what it was built never to keep.
  it.each([
    ['text with spaces', { reason: 'The gate was welded shut' }],
    ['a lower-case token', { reason: 'run_cut_short' }],
    ['a number as text', { reason: '233201234567' }],
    ['a number', { reason: 7 }],
    ['a flag', { reason: true }],
    ['a null', { reason: null }],
    ['a list', { reason: ['RUN_CUT_SHORT'] }],
    ['a nested object', { reason: { code: 'RUN_CUT_SHORT' } }],
    ['a value over 64 characters', { reason: 'A'.repeat(65) }],
    ['an empty value', { reason: '' }],
    ['five members', { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }],
    ['an upper-case name', { Reason: 'RUN_CUT_SHORT' }],
    ['a name with a space', { 'the reason': 'RUN_CUT_SHORT' }],
    ['a name that begins with a digit', { '1reason': 'RUN_CUT_SHORT' }],
    ['a name over 32 characters', { [`a${'b'.repeat(32)}`]: 'RUN_CUT_SHORT' }],
    ['a list as the document', ['RUN_CUT_SHORT']],
    ['a string as the document', 'RUN_CUT_SHORT'],
  ])('refuses %s', async (_what, parameters) => {
    expect(await makes(parameters)).toBe('23514');
  });

  // Break caught: the lane's login able to change what a message says after it was made, or unable to write it when it makes the message.
  it('are written by the lane when it makes the message and changed by nobody afterwards', async () => {
    const rows = await admin.query<{ insert: boolean; update: boolean }>(
      `select has_table_privilege('melarc_worker_cap_notification', 'notification', 'INSERT') as insert,
              has_column_privilege('melarc_worker_cap_notification', 'notification', 'parameters', 'UPDATE') as update`,
    );
    expect(rows.rows[0]).toEqual({ insert: true, update: false });
    const api = await admin.query<{ update: boolean; insert: boolean }>(
      `select has_column_privilege('melarc_api_runtime', 'notification', 'parameters', 'UPDATE') as update,
              has_table_privilege('melarc_api_runtime', 'notification', 'INSERT') as insert`,
    );
    expect(api.rows[0]).toEqual({ update: false, insert: false });
  });
});
