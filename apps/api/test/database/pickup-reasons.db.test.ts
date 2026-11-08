import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REASON_DOMAINS } from '../../src/platform/database/schema/reference-data.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { IDENTITY_REASONS } from '../../src/tools/seed/reasons.js';
import { WORKFLOW_REASONS } from '../../src/tools/seed/workflow-reasons.js';
import { applyMigration, seedEarlierContent } from './support/earlier-seed.js';
import { observe, type Observer } from './support/observe.js';
import { seedReferenceData } from './support/seeded.js';
import {
  clientFor,
  createTestDatabase,
  sqlState,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S1.7: the reasons of SLICE-001 reach a database that was seeded before them (migrations 0044 and 0054), and a new database gets the same from
 * the seed, by one rule (the rule of S1.8's grants, MIGRATION_AND_SEEDING.md section 4). The claims, each against a real PostgreSQL:
 *
 * - **The closed set is widened and is still closed.** The three domains admitted on 29 October 2026 (D-05) are accepted by the table's
 *   check; a domain that is not in the set still is not.
 * - **Converge.** An earlier seed plus the migration holds exactly the reasons a new seed writes, row for row.
 * - **Nothing to do is nothing done.** An unseeded database is left empty (the seed writes everything there), a seeded one that already
 *   holds the reasons is untouched, and the file may run again.
 * - **Nothing invented.** The codes of the three catalogue domains are the 25 the Product Owner approved on 29 October 2026 (migration 0054),
 *   and no others, after either path.
 */
// 0044 widens the closed set of domains and adds the four of the stop skip; 0054 adds the 25 codes of the three pickup catalogues the Product
// Owner approved on 29 October 2026; 0061 adds the eight carry-over codes decided on 2 November 2026 (the domain itself was admitted by 0059).
// A database seeded earlier gets them in order.
const MIGRATIONS = [
  '0044_pickup_reason_domains.sql',
  '0054_pickup_reason_codes.sql',
  '0061_pickup_carryover_reasons.sql',
];
const CATALOGUE_DOMAINS = ['PICKUP_CANCELLATION', 'PICKUP_FAILURE', 'PICKUP_SHORT_COUNT'];
/**
 * The closed set of domains as the database holds it now: the code's own list (`REASON_DOMAINS`), which migration 0059 brought up to date.
 * Migration 0044 closes the set as it was on 27 October 2026, and this test applies it again to a database that already holds the later
 * migrations, so the set is put back to the current one after it, before the files that write codes of a domain the old set lacks.
 */
const CURRENT_DOMAINS = `ALTER TABLE reason_code DROP CONSTRAINT reason_code_domain_closed;
ALTER TABLE reason_code ADD CONSTRAINT reason_code_domain_closed CHECK (domain IN (${REASON_DOMAINS.map((domain) => `'${domain}'`).join(', ')}))`;
/**
 * Applies the migrations a database seeded earlier gets, in order. Migration 0044 is the first, and it closes the set of domains as it stood on
 * 27 October 2026; the migrator applies it once, before any code of a later domain exists, and a database that already holds one (a carry-over
 * code) cannot take its set again. So it is not applied then: the files that write codes (0054, 0061) are the ones written to be repeated.
 */
const applyReasonMigrations = async (w: Pick<World, 'migration' | 'admin'>): Promise<void> => {
  const later = await w.admin.query(
    `select 1 from reason_code where domain = 'PICKUP_CARRYOVER' limit 1`,
  );
  for (const file of MIGRATIONS) {
    if (file === MIGRATIONS[0] && (later.rowCount ?? 0) > 0) continue;
    await applyMigration(w.migration, file);
    if (file === MIGRATIONS[0]) await w.migration.query(CURRENT_DOMAINS);
  }
};
const codesOf = (domain: string): string[] =>
  WORKFLOW_REASONS.filter((reason) => reason.domain === domain)
    .map((reason) => reason.code)
    .toSorted();

interface World {
  readonly database: TestDatabase;
  readonly migration: pg.Client;
  readonly admin: pg.Client;
  readonly observer: Observer;
  close(): Promise<void>;
}

async function world(): Promise<World> {
  const database = await createTestDatabase();
  const migration = clientFor(database.urlFor(MIGRATION_ROLE));
  const admin = clientFor(database.urlFor('postgres'));
  await migration.connect();
  await admin.connect();
  const observer = await observe(database);
  return {
    database,
    migration,
    admin,
    observer,
    close: async () => {
      await migration.end();
      await admin.end();
      await observer.close();
      await database.drop();
    },
  };
}

const reasons = (observer: Observer) =>
  observer.rows<Record<string, unknown>>(
    `select code, domain, valid_checkpoints, label, requires_note, requires_photo, requires_contact_attempt, requires_approval,
            attribution, consumes_delivery_attempt, requires_ops_review, requires_escalation, active, permitted_operations
       from reason_code order by code collate "C"`,
  );

/** A row of a domain with the least a row needs, inserted as the cluster administrator and rolled back. */
async function acceptsDomain(admin: pg.Client, domain: string): Promise<string | undefined> {
  await admin.query('BEGIN');
  try {
    return await sqlState(
      admin,
      `insert into reason_code (code, domain, label, attribution) values ('FIXTURE_DOMAIN_PROBE', $1, 'Probe', 'MELARC')`,
      [domain],
    );
  } finally {
    await admin.query('ROLLBACK');
  }
}

describe('the closed set of reason domains', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.close();
  });

  // Break caught: the table's check still refusing a domain the catalogue admits, so a reason of it could never be seeded or added.
  it.each(CATALOGUE_DOMAINS)('accepts %s, admitted on 29 October 2026', async (domain) => {
    expect(await acceptsDomain(w.admin, domain)).toBeUndefined();
  });

  // Break caught: the check dropped and not replaced, or replaced by one that admits anything.
  it('still refuses a domain that is not in the set', async () => {
    expect(await acceptsDomain(w.admin, 'NOT_A_DOMAIN')).toBe('23514');
    expect(await acceptsDomain(w.admin, 'pickup_failure')).toBe('23514');
  });

  it('is the set the code names: every workflow and identity domain is accepted', async () => {
    for (const domain of REASON_DOMAINS) {
      // An identity domain also needs its operations; only the check of the domain itself is asked about here.
      const state = await acceptsDomain(w.admin, domain);
      expect(state === undefined || state === '23514', domain).toBe(true);
      if (state === '23514') {
        // Refused by another check (the operations of an identity reason), never by the closed set of domains.
        expect(CATALOGUE_DOMAINS).not.toContain(domain);
      }
    }
  });
});

describe('a database that has not been seeded', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.close();
  });

  // Break caught: the migration writing reasons before the seed, which would then refuse a table that is not empty.
  it('is left without a reason by the migration, whether it ran at creation or runs again', async () => {
    expect(await reasons(w.observer)).toEqual([]);
    await applyReasonMigrations(w);
    expect(await reasons(w.observer)).toEqual([]);
  });

  it('is seeded with the twelve identity reasons and the 37 workflow ones, and the migrations after the seed change nothing', async () => {
    await seedReferenceData(w.database);
    const seeded = await reasons(w.observer);
    expect(seeded).toHaveLength(IDENTITY_REASONS.length + WORKFLOW_REASONS.length);
    await applyReasonMigrations(w);
    expect(await reasons(w.observer)).toEqual(seeded);
  });
});

describe('a database seeded before SLICE-001 (the owner’s)', () => {
  let earlier: World;
  let fresh: World;
  beforeAll(async () => {
    [earlier, fresh] = await Promise.all([world(), world()]);
    await seedEarlierContent(earlier.database);
    await seedReferenceData(fresh.database);
  });
  afterAll(async () => {
    await Promise.all([earlier.close(), fresh.close()]);
  });

  it('starts with the twelve identity reasons and none of the workflow ones', async () => {
    const before = await reasons(earlier.observer);
    expect(before).toHaveLength(IDENTITY_REASONS.length);
    expect(before.some((row) => row.domain === 'PICKUP_STOP_SKIP')).toBe(false);
  });

  describe('once migrations 0044, 0054 and 0061 are applied', () => {
    beforeAll(async () => {
      await applyReasonMigrations(earlier);
    });

    // Break caught: a row that differs from the seed's in a flag, a label or an attribution, which the two ways to a database would
    // then hand to different people.
    it('holds exactly the reasons a new seed writes, row for row', async () => {
      expect(await reasons(earlier.observer)).toEqual(await reasons(fresh.observer));
    });

    it('holds the four codes of the stop skip, once each', async () => {
      const rows = await reasons(earlier.observer);
      const skip = rows.filter((row) => row.domain === 'PICKUP_STOP_SKIP');
      expect(skip.map((row) => row.code).toSorted()).toEqual(codesOf('PICKUP_STOP_SKIP'));
      expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
    });

    // Break caught: a code missing, invented or moved to another domain by the migration, which an operation that takes a reason of the
    // domain would then refuse or accept: the 25 codes are the ones the Product Owner approved, by domain, and no others.
    it('holds the 25 codes of the three pickup catalogues the Product Owner approved, and no others', async () => {
      const rows = await reasons(earlier.observer);
      for (const domain of CATALOGUE_DOMAINS) {
        expect(
          rows
            .filter((row) => row.domain === domain)
            .map((row) => row.code as string)
            .toSorted(),
          domain,
        ).toEqual(codesOf(domain));
      }
      expect(rows.filter((row) => CATALOGUE_DOMAINS.includes(row.domain as string))).toHaveLength(
        25,
      );
    });

    // Break caught: a carry-over code, attribution or note requirement the migration wrote differently from the decision of 2 November 2026,
    // or a code of another domain taken over by it: the eight are the Product Owner's, each in the domain of its own.
    it('holds the eight carry-over codes decided on 2 November 2026, and leaves the cancellation catalogue as it was', async () => {
      const rows = await reasons(earlier.observer);
      expect(
        rows
          .filter((row) => row.domain === 'PICKUP_CARRYOVER')
          .map((row) => [row.code, row.attribution, row.requires_note, row.active]),
      ).toEqual(
        codesOf('PICKUP_CARRYOVER').map((code) => {
          const seeded = WORKFLOW_REASONS.find((reason) => reason.code === code);
          return [code, seeded?.attribution, seeded?.requiresNote, true];
        }),
      );
      expect(rows.filter((row) => row.domain === 'PICKUP_CARRYOVER')).toHaveLength(8);
      // A code the cancellation catalogue holds is still the cancellation catalogue's, with its own requirements.
      expect(rows.find((row) => row.code === 'ROAD_OR_WEATHER_DISRUPTION')).toMatchObject({
        domain: 'PICKUP_CANCELLATION',
        requires_note: false,
      });
      expect(rows.find((row) => row.code === 'CARRYOVER_ROAD_OR_WEATHER_DISRUPTION')).toMatchObject(
        { domain: 'PICKUP_CARRYOVER', requires_note: true },
      );
    });

    // Break caught: a migration that cannot run twice, or that inserts the same code again.
    it('may run again: the second run changes nothing', async () => {
      const before = await reasons(earlier.observer);
      await applyReasonMigrations(earlier);
      expect(await reasons(earlier.observer)).toEqual(before);
    });
  });
});
