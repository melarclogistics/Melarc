import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { runSeed } from '../../src/platform/database/seed/seed-helper.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  DatabaseNotificationSettings,
  DatabaseSettingsReader,
  SMS_SETTING_KEYS,
} from '../../src/platform/notifications/notification-settings.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { referenceSeedPlan } from '../../src/tools/seed/reference-seed.js';
import { SETTINGS } from '../../src/tools/seed/settings.js';
import { seedReferenceData } from './support/seeded.js';
import { systemContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S1.12e against a real PostgreSQL: the three platform settings of the business text messages (settings.md section 7.8; migration 0056).
 * The lane's capability reads those three rows and the two columns that say what a setting is, and nothing else of the table; a database
 * seeded before them gets exactly the rows a new seed writes; the settings the lane reads are the ones the pilot decided.
 */
const NEW_KEYS = ['sms_enabled', 'sms_per_number_daily_limit', 'sms_daily_limit'] as const;
const MIGRATIONS = resolve(import.meta.dirname, '../../migrations');
const clock = new SystemClock();

/** The statements of one migration file, in order. */
const statementsOf = (file: string): string[] =>
  readFileSync(resolve(MIGRATIONS, file), 'utf8')
    .replaceAll('\r\n', '\n')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

/** The data statement of the migration, the one that gives a seeded database its rows (the policy and the grant are structure). */
const dataStatement = (): string => {
  const found = statementsOf('0056_notification_settings.sql').find((statement) =>
    statement.includes('DO $notification_settings$'),
  );
  if (found === undefined) throw new Error('the data statement of 0056 was not found');
  return found;
};

/** The seed of a database as it was before the three settings: the same plan without their rows. */
async function seedWithoutTheNewSettings(database: TestDatabase): Promise<void> {
  const plan = referenceSeedPlan();
  const { service, close } = buildService(database, { login: PROVISIONING_ROLE });
  try {
    await runSeed(service, {
      ...plan,
      payload: {
        ...plan.payload,
        setting: (plan.payload.setting ?? []).filter(
          (row) => !(NEW_KEYS as readonly string[]).includes(row.key as string),
        ),
      },
    });
  } finally {
    await close();
  }
}

describe('what the lane reads of the settings', () => {
  let database: TestDatabase;
  let admin: pg.Client;
  let work: ReturnType<typeof buildService>;
  const lane: SecurityContext = systemContext('notification');

  beforeAll(async () => {
    database = await createTestDatabase();
    await seedReferenceData(database);
    admin = clientFor(database.urlFor('postgres'));
    await admin.connect();
    work = buildService(database, { login: WORKER_RUNTIME_ROLE });
  });
  afterAll(async () => {
    await work.close();
    await admin.end();
    await database.drop();
  });

  const rows = async (context: SecurityContext, statement: ReturnType<typeof sql>) =>
    work.service.transactionWithContext(context, async (tx) => (await tx.execute(statement)).rows);
  const stateOf = async (context: SecurityContext, statement: ReturnType<typeof sql>) => {
    try {
      await rows(context, statement);
      return undefined;
    } catch (error) {
      return serverErrorIn(error)?.code;
    }
  };

  // Break caught: the lane reading the pilot figures from the wrong place, or the seed writing other figures than the owner decided.
  it('reads the switch and the two pilot limits of the Product Owner’s decision of 29 October 2026', async () => {
    const reader = new DatabaseSettingsReader({ database: work.service, clock });
    const found = await reader.read(Object.values(SMS_SETTING_KEYS));
    expect(Object.fromEntries(found)).toEqual({
      sms_enabled: true,
      sms_per_number_daily_limit: 10,
      sms_daily_limit: 500,
    });
    const settings = new DatabaseNotificationSettings({ reader, clock });
    expect(await settings.smsEnabled()).toBe(true);
    expect(await settings.limits()).toEqual({ perNumberPerDay: 10, perDay: 500 });
  });

  // Break caught (the point of a policy that names its rows): the lane able to read the settings of authentication, the limiter, the money. It does not read the
  // length of a handshake code either (migration 0073): the length a code is made with is kept with the code (`collection_handshake.code_length`), so a setting
  // changed between the issue and the send cannot change the code the lane texts, and the lane has no use for the setting.
  it('sees these three rows of the settings table and no other, the length of a handshake code included', async () => {
    const seen = await rows(lane, sql`select key from setting order by key`);
    expect(seen.map((row) => row.key)).toEqual([...NEW_KEYS].toSorted());
    expect(seen.map((row) => row.key)).not.toContain('handshake_code_length');
    const held = await admin.query('select count(*)::int as n from setting');
    expect((held.rows[0] as { n: number }).n).toBeGreaterThan(4);
  });

  // Break caught: a column grant wider than the key and the value, which would show the lane a description or a unit it has no use for.
  it('reads the key and the value and no other column of a setting', async () => {
    expect(await stateOf(lane, sql`select key, value from setting`)).toBeUndefined();
    for (const column of ['unit', 'description', 'scope', 'value_type', 'created_at']) {
      expect(await stateOf(lane, sql.raw(`select ${column} from setting`)), column).toBe('42501');
    }
  });

  // Break caught: the capability able to change a setting, which would let a lane turn off its own limits.
  it('writes nothing of the settings', async () => {
    expect(
      await stateOf(lane, sql`update setting set value = 'false'::jsonb where key = 'sms_enabled'`),
    ).toBe('42501');
    expect(await stateOf(lane, sql`delete from setting where key = 'sms_enabled'`)).toBe('42501');
    expect(
      await stateOf(
        lane,
        sql`insert into setting (key, scope, value_type, value, unit, description) values ('sms_other', 'PLATFORM', 'boolean', 'true'::jsonb, 'x', 'x')`,
      ),
    ).toBe('42501');
  });

  // Break caught: the policy reading the capability alone, so that the credential delivery (the worker's other capability) reads settings too.
  it('shows the worker’s other capability none of them', async () => {
    expect(await rows(systemContext('credential_delivery'), sql`select key from setting`)).toEqual(
      [],
    );
  });

  it('reads a switch an administrator turned off, and an administrator’s limit', async () => {
    await admin.query(`update setting set value = 'false'::jsonb where key = 'sms_enabled'`);
    await admin.query(
      `update setting set value = '3'::jsonb where key = 'sms_per_number_daily_limit'`,
    );
    try {
      const settings = new DatabaseNotificationSettings({
        reader: new DatabaseSettingsReader({ database: work.service, clock }),
        clock,
        cacheMs: 0,
      });
      expect(await settings.smsEnabled()).toBe(false);
      expect(await settings.limits()).toEqual({ perNumberPerDay: 3, perDay: 500 });
    } finally {
      await admin.query(`update setting set value = 'true'::jsonb where key = 'sms_enabled'`);
      await admin.query(
        `update setting set value = '10'::jsonb where key = 'sms_per_number_daily_limit'`,
      );
    }
  });
});

describe('a database seeded before the three settings (migration 0056)', () => {
  const rowsOf = async (client: pg.Client) =>
    (
      await client.query(
        `select key, scope, value_type, value, unit, description from setting where key = any($1) order by key`,
        [[...NEW_KEYS]],
      )
    ).rows as Record<string, unknown>[];

  const seeded = SETTINGS.filter((row) => (NEW_KEYS as readonly string[]).includes(row.key)).map(
    (row) => ({
      key: row.key,
      scope: row.scope,
      value_type: row.valueType,
      value: row.value,
      unit: row.unit,
      description: row.description,
    }),
  );

  // Break caught: a migration that writes other rows than the seed writes (a different unit, a rounded limit, a switch that starts Off).
  it('gets exactly the rows a new seed writes, once, and the file may run again', async () => {
    const database = await createTestDatabase();
    const migration = clientFor(database.urlFor(MIGRATION_ROLE));
    const admin = clientFor(database.urlFor('postgres'));
    await migration.connect();
    await admin.connect();
    try {
      await seedWithoutTheNewSettings(database);
      expect(await rowsOf(admin)).toEqual([]);
      for (let run = 0; run < 2; run += 1) {
        await migration.query('BEGIN');
        await migration.query(dataStatement());
        await migration.query('COMMIT');
        expect(await rowsOf(admin), `run ${String(run + 1)}`).toEqual(
          seeded.toSorted((a, b) => a.key.localeCompare(b.key)),
        );
      }
      expect(seeded.map((row) => row.key).toSorted()).toEqual([...NEW_KEYS].toSorted());
    } finally {
      await migration.end();
      await admin.end();
      await database.drop();
    }
  });

  // Break caught: the migration seeding an empty database, which the seed then refuses because it holds a row.
  it('leaves a database that has not been seeded empty', async () => {
    const database = await createTestDatabase();
    const migration = clientFor(database.urlFor(MIGRATION_ROLE));
    const admin = clientFor(database.urlFor('postgres'));
    await migration.connect();
    await admin.connect();
    try {
      await migration.query('BEGIN');
      await migration.query(dataStatement());
      await migration.query('COMMIT');
      expect(await rowsOf(admin)).toEqual([]);
    } finally {
      await migration.end();
      await admin.end();
      await database.drop();
    }
  });

  // Break caught: the migration overwriting a value the administrator changed before the file ran again.
  it('does not touch a value that was changed', async () => {
    const database = await createTestDatabase();
    const migration = clientFor(database.urlFor(MIGRATION_ROLE));
    const admin = clientFor(database.urlFor('postgres'));
    await migration.connect();
    await admin.connect();
    try {
      await seedWithoutTheNewSettings(database);
      await migration.query('BEGIN');
      await migration.query(dataStatement());
      await migration.query('COMMIT');
      await admin.query(
        `update setting set value = '25'::jsonb where key = 'sms_per_number_daily_limit'`,
      );
      await migration.query('BEGIN');
      await migration.query(dataStatement());
      await migration.query('COMMIT');
      const held = await admin.query(
        `select value from setting where key = 'sms_per_number_daily_limit'`,
      );
      expect(held.rows[0]).toEqual({ value: 25 });
    } finally {
      await migration.end();
      await admin.end();
      await database.drop();
    }
  });
});
