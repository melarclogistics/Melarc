import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7From } from '../../src/platform/auth/crypto/uuid-v7.js';
import { MfaFactorStore } from '../../src/platform/auth/mfa/mfa-factor-store.js';
import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { factorRow, insertFactor } from './support/credentials.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * F01 of the audit of 22 October 2026 (migration 0025): the order of an identity's factors is **a column the database allocates**, and
 * not the order of their identifiers. A UUIDv7 is time-ordered to the millisecond of the clock it is given and no more: two factors
 * made in one millisecond are not ordered between themselves, and nothing orders them across a clock that steps back. The reset rule
 * reads "the most recent factor", so the order has to be true. `ordinal` is allocated under the identity's lock, from one, by the
 * database for every path that creates a factor, and it never changes.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let unitOfWork: PostgresUnitOfWork;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
  unitOfWork = new PostgresUnitOfWork(built.service);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const identity = (): Promise<StaffRow> => insertStaff(admin, staffRow());
const ordinalsOf = async (row: StaffRow): Promise<{ id: string; ordinal: number }[]> =>
  (
    await admin.query<{ id: string; ordinal: number }>(
      'select id, ordinal from mfa_factor where staff_identity_id = $1 order by ordinal',
      [row.id],
    )
  ).rows;

/** Three ids that sort against the order of creation (the first made is the greatest), new for each test: an id is a primary key. */
const reversed = (): string[] => {
  const tail = randomUUID().slice(24);
  return [
    `ffffffff-ffff-7fff-bfff-${tail}`,
    `eeeeeeee-eeee-7eee-beee-${tail}`,
    `00000000-0000-7000-8000-${tail}`,
  ];
};

describe('the ordinal of a factor', () => {
  // Break caught: an order left to the identifiers (or to whatever the application chose), so that a rule reading "the most recent
  // factor" reads the wrong one when two identifiers are made in the same millisecond or the clock steps back.
  it('is allocated by the database, from one, in the order the factors are created, whatever their identifiers are', async () => {
    const row = await identity();
    const ids = reversed();
    for (const id of ids) await insertFactor(admin, factorRow(row.id, { id }));

    expect(await ordinalsOf(row)).toEqual(ids.map((id, at) => ({ id, ordinal: at + 1 })));
  });

  // Break caught: the order of one identity's factors counted across identities, or shared.
  it('counts for each identity apart', async () => {
    const first = await identity();
    const second = await identity();
    await insertFactor(admin, factorRow(first.id));
    await insertFactor(admin, factorRow(first.id));
    await insertFactor(admin, factorRow(second.id));

    expect((await ordinalsOf(first)).map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect((await ordinalsOf(second)).map((entry) => entry.ordinal)).toEqual([1]);
  });

  // Break caught: a creator choosing its own place in the order, which would let a path that does not know the rule write one that is
  // not true: the database is the one allocator, and what it is given is not read.
  it('is the database’s own: a value a statement gives is not the one that is stored', async () => {
    const row = await identity();
    const id = randomUUID();
    await admin.query(
      `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                               secret_envelope_version, created_by_purpose, ordinal)
       values ($1, $2, 'TOTP', 'PENDING', decode(repeat('ab', 40), 'hex'), decode(repeat('cd', 12), 'hex'), 1, 1,
               'STAFF_CREDENTIAL_SETUP', 99)`,
      [id, row.id],
    );

    expect((await ordinalsOf(row)).map((entry) => entry.ordinal)).toEqual([1]);
  });

  // Break caught: an order that can be rewritten after the fact, by any login (the administrator included, as every guard of the table).
  it('never changes: no login can move a factor in the order', async () => {
    const row = await identity();
    const factor = await insertFactor(admin, factorRow(row.id));

    await expect(
      admin.query('update mfa_factor set ordinal = 5 where id = $1', [factor.id]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await ordinalsOf(row)).map((entry) => entry.ordinal)).toEqual([1]);
  });

  // Break caught: no constraint behind the allocation: two factors of one identity sharing a place, which a path that bypassed the
  // trigger would write. The unique index is the backstop.
  it('is unique within an identity, by an index of its own', async () => {
    const found = await admin.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'mfa_factor' and indexname = 'mfa_factor_identity_ordinal_key'`,
    );

    expect(found.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(staff_identity_id, ordinal\)/);
  });

  // Break caught: two enrolments that start together taking the same place (or one of them failing on the index): the allocation is
  // made under the identity's lock, so they take turns and the places are consecutive.
  it('is allocated under the identity’s lock: two creations that overlap take two places and neither fails', async () => {
    const row = await identity();
    const first = clientFor(database.urlFor('postgres'));
    const second = clientFor(database.urlFor('postgres'));
    await first.connect();
    await second.connect();
    const insert = (client: pg.Client) =>
      client.query(
        `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                                 secret_envelope_version, created_by_purpose)
         values ($1, $2, 'TOTP', 'PENDING', decode(repeat('ab', 40), 'hex'), decode(repeat('cd', 12), 'hex'), 1, 1,
                 'STAFF_CREDENTIAL_SETUP')`,
        [randomUUID(), row.id],
      );
    try {
      await first.query('begin');
      await insert(first);
      await second.query('begin');
      const waiting = insert(second);
      // The second creation waits for the first, which holds the identity's lock: it is blocked, not failed.
      const blocked = await (async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const probe = await admin.query(
            `select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database() and query like 'insert into mfa_factor%'`,
          );
          if (probe.rows.length > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
      })();
      await first.query('commit');
      await waiting;
      await second.query('commit');

      expect(blocked).toBe(true);
      expect((await ordinalsOf(row)).map((entry) => entry.ordinal)).toEqual([1, 2]);
    } finally {
      await first.end();
      await second.end();
    }
  });
});

describe('the factor store reads the latest factor by the ordinal', () => {
  const store = new MfaFactorStore({
    cipher: {
      seal: () => Promise.reject(new Error('no sealing in this test')),
      open: () => Promise.reject(new Error('no opening in this test')),
    },
    clock: new ManualClock(new Date()),
  });

  // Break caught: "the most recent" read as the greatest identifier: two factors made in one millisecond, and a clock that steps back,
  // are the cases it reads wrongly.
  it('answers the factor created last when its identifier is the smaller', async () => {
    const row = await identity();
    // Made with a clock that stepped back: the second identifier is earlier than the first.
    const later = uuidV7From(Date.parse('2026-10-22T10:00:00.000Z'), Buffer.alloc(16, 1));
    const earlier = uuidV7From(Date.parse('2026-10-22T09:00:00.000Z'), Buffer.alloc(16, 2));
    await insertFactor(admin, factorRow(row.id, { id: later }));
    await insertFactor(admin, factorRow(row.id, { id: earlier }));

    const latest = await unitOfWork.run(systemContext('authentication'), (handle) =>
      store.findLatestOf(handle, row.id),
    );

    expect(latest?.id).toBe(earlier);
    expect(latest?.ordinal).toBe(2);
  });

  // Break caught: the pending factors, which a re-enrolment supersedes, listed in the order of their identifiers.
  it('lists the pending factors oldest first by the ordinal', async () => {
    const row = await identity();
    const ids = reversed();
    for (const id of ids) await insertFactor(admin, factorRow(row.id, { id }));

    const pending = await unitOfWork.run(systemContext('authentication'), (handle) =>
      store.findPendingOf(handle, row.id),
    );

    expect(pending.map((factor) => factor.id)).toEqual(ids);
  });
});

describe('the migration that adds the ordinal', () => {
  const NEW_FROM = 25;
  let folder: string;
  let target: TestDatabase;

  /** A private copy of the migrations folder that holds the history before the ordinal, to apply first. */
  function historyBefore(): string {
    const copy = mkdtempSync(join(tmpdir(), 'melarc-ordinal-'));
    cpSync(MIGRATIONS_FOLDER, copy, { recursive: true });
    for (const name of readdirSync(copy)) {
      if (name.endsWith('.sql') && Number(name.slice(0, 4)) >= NEW_FROM) rmSync(join(copy, name));
    }
    for (const name of readdirSync(join(copy, 'meta'))) {
      const number = Number(name.slice(0, 4));
      if (name.endsWith('_snapshot.json') && number >= NEW_FROM) rmSync(join(copy, 'meta', name));
    }
    const journalPath = join(copy, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx < NEW_FROM);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    return copy;
  }

  async function before(): Promise<pg.Client> {
    target = await createTestDatabase({ migrate: false });
    folder = historyBefore();
    await runMigrations({ url: target.urlFor(MIGRATION_ROLE), folder });
    const client = clientFor(target.urlFor('postgres'));
    await client.connect();
    return client;
  }
  async function after(client: pg.Client): Promise<void> {
    await client.end();
    rmSync(folder, { recursive: true, force: true });
    await target.drop();
  }

  // Break caught: the existing factors left without a place, or given one by the order of their identifiers: where an identity has one
  // factor its place is not in doubt, and it is one.
  it('gives the one factor of each identity the place one, and the table holds nothing without a place', async () => {
    const client = await before();
    try {
      await seedReferenceData(target);
      const row = await insertStaff(client, staffRow());
      const revoked = await insertFactor(client, factorRow(row.id));
      await client.query(
        `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
        [revoked.id],
      );
      const other = await insertStaff(client, staffRow());
      await insertFactor(client, factorRow(other.id));

      await runMigrations({ url: target.urlFor(MIGRATION_ROLE) });

      const places = await client.query<{ ordinal: number }>(
        'select ordinal from mfa_factor order by ordinal',
      );
      expect(places.rows).toEqual([{ ordinal: 1 }, { ordinal: 1 }]);
      const column = await client.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns where table_name = 'mfa_factor' and column_name = 'ordinal'`,
      );
      expect(column.rows[0]?.is_nullable).toBe('NO');
    } finally {
      await after(client);
    }
  });

  // Break caught: an order invented for the history of an identity with several factors, which nothing recorded: the identifiers say
  // nothing true of it. The migration refuses, names what it found, and changes nothing.
  it('refuses to invent an order for an identity that already holds several factors, and changes nothing', async () => {
    const client = await before();
    try {
      await seedReferenceData(target);
      const row = await insertStaff(client, staffRow());
      await insertFactor(client, factorRow(row.id));
      await insertFactor(client, factorRow(row.id));

      await expect(runMigrations({ url: target.urlFor(MIGRATION_ROLE) })).rejects.toThrow(
        /several factors/,
      );

      const column = await client.query(
        `select 1 from information_schema.columns where table_name = 'mfa_factor' and column_name = 'ordinal'`,
      );
      expect(column.rows).toEqual([]);
      const journal = await client.query<{ n: number }>(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      expect(journal.rows[0]?.n).toBe(NEW_FROM);
    } finally {
      await after(client);
    }
  });
});
