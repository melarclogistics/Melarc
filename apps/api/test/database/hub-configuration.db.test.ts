import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import { SeedRefusedError, runSeed } from '../../src/platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import {
  HUB_SETTINGS,
  LAUNCH_HUB_ID,
  SERVICE_ZONES,
  hubConfigurationPlan,
} from '../../src/tools/seed/hub-configuration.js';
import {
  HUB_A,
  HUB_B,
  RIDER_1,
  VENDOR_1,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import {
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S1.4 against a real PostgreSQL: the hub's configuration tables (`service_zone`, `service_zone_alias`, `hub_setting`; migration 0042;
 * data-scope-registry.md `ServiceZone`, `ServiceZoneAlias`, `HubSetting`). Read as `melarc_api_runtime` under each principal type,
 * written as the cluster administrator where a constraint is under test (a constraint binds a superuser too; row-level security does
 * not), and filled through the one function, `melarc.seed_hub_configuration`, as the provisioning login.
 */

const TABLES = ['service_zone', 'service_zone_alias', 'hub_setting'] as const;

const ZONE_A = '5eed0101-0000-4000-8000-0000000000a1';
const ZONE_B = '5eed0101-0000-4000-8000-0000000000b1';
const ACTOR = '5eed0000-0000-4000-8000-0000000000a1';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await withClient(database.urlFor('postgres'), async (admin) => {
    await admin.query(
      `insert into hub (id, name) values ('${HUB_A}', 'Hub A'), ('${HUB_B}', 'Hub B')`,
    );
    await admin.query(
      `insert into service_zone (id, hub_id, code, name, service_area) values
         ('${ZONE_A}', '${HUB_A}', 'TEMA', 'Tema', 'ACCRA_TEMA'),
         ('${ZONE_B}', '${HUB_B}', 'TEMA', 'Tema', 'ACCRA_TEMA')`,
    );
    await admin.query(
      `insert into service_zone_alias (id, hub_id, zone_id, alias, kind) values
         (gen_random_uuid(), '${HUB_A}', '${ZONE_A}', 'community 1', 'AREA'),
         (gen_random_uuid(), '${HUB_B}', '${ZONE_B}', 'community 1', 'AREA')`,
    );
    await admin.query(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by) values
         (gen_random_uuid(), '${HUB_A}', 'station_drop_fee', '', 1, '2000', 'pesewas', '2026-10-01T00:00:00Z', '${ACTOR}'),
         (gen_random_uuid(), '${HUB_B}', 'station_drop_fee', '', 1, '2500', 'pesewas', '2026-10-01T00:00:00Z', '${ACTOR}')`,
    );
    await admin.query(
      `insert into setting (key, scope, value_type, value, unit, description) values
         ('liability_cap_amount', 'COMPANY', 'integer', '30000', 'pesewas', 'The cap'),
         ('rate_limit_staff_signin', 'PLATFORM', 'object', '{}', 'requests', 'A security parameter')`,
    );
  });
});

afterAll(async () => {
  await database.drop();
});

const countOf = async (tx: DatabaseTransaction, table: string): Promise<number> =>
  Number((await tx.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]?.n);

/** The SQLSTATE a statement ends with inside a transaction of the runtime login under `context`, or `undefined` if it ran. */
async function runtimeState(
  context: SecurityContext,
  statement: string,
): Promise<string | undefined> {
  const { service, close } = buildService(database);
  try {
    await service.transactionWithContext(context, async (tx) => {
      await tx.execute(sql.raw(statement));
    });
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  } finally {
    await close();
  }
}

describe('who reads the hub configuration (data-scope-registry.md §4.2 and §5.2)', () => {
  // The rows each table holds per hub: one zone, one alias, one setting.
  const contexts: [string, SecurityContext, number][] = [
    ['staff of hub A', staffContext([HUB_A]), 1],
    ['staff of both hubs', staffContext([HUB_A, HUB_B]), 2],
    ['staff with all-hub scope', staffContext([], 'ALL'), 2],
    ['staff of a hub with no rows', staffContext(['33333333-3333-4333-8333-333333333333']), 0],
    ['the configuration capability', systemContext('configuration'), 2],
    ['the authentication capability', systemContext('authentication'), 0],
    ['a SYSTEM context under another capability', systemContext('rate_limit'), 0],
    ['a vendor (DENY)', vendorContext(VENDOR_1), 0],
    ['a rider (DENY)', riderContext(RIDER_1), 0],
  ];

  // Break caught: a hub's configuration readable by a principal the registry denies, or unreadable to the one it admits, or a staff
  // policy that leaks the other hub's fees (§33.4: settings never inherit, so a hub must never see or borrow another's).
  it.each(contexts)('%s reads each table', async (_label, context, expected) => {
    const { service, close } = buildService(database);
    try {
      const seen = await service.transactionWithContext(context, async (tx) => {
        const counts: Record<string, number> = {};
        for (const table of TABLES) counts[table] = await countOf(tx, table);
        return counts;
      });
      for (const table of TABLES) expect(seen[table], table).toBe(expected);
    } finally {
      await close();
    }
  });

  // Break caught: the configuration capability reaching a security parameter. It reads the COMPANY-scope business rules and no
  // PLATFORM row; the authentication capability keeps reading all of them through its own policy.
  it('lets the configuration capability read the company settings and no platform setting', async () => {
    const { service, close } = buildService(database);
    try {
      const keys = await service.transactionWithContext(
        systemContext('configuration'),
        async (tx) =>
          (await tx.execute(sql.raw('select key from setting order by key'))).rows.map(
            (row) => row.key,
          ),
      );
      expect(keys).toEqual(['liability_cap_amount']);
    } finally {
      await close();
    }
  });

  // Break caught: a context with no principal reading a table. Every branch is false.
  it('reads nothing with no context at all', async () => {
    const { Client } = await import('pg');
    const { postgresConnectionSettings } =
      await import('../../src/platform/database/postgres-url.js');
    const client = new Client({
      ...postgresConnectionSettings(database.urlFor('melarc_api_runtime')),
    });
    client.on('error', () => undefined);
    await client.connect();
    try {
      for (const table of TABLES) {
        expect(await scalar<number>(client, `select count(*)::int from ${table}`), table).toBe(0);
      }
    } finally {
      await client.end();
    }
  });
});

describe('who writes it: nobody, in place (immutable rows, a seed function for entry)', () => {
  const statements = {
    service_zone: {
      insert: `insert into service_zone (id, hub_id, code, name, service_area) values (gen_random_uuid(), '${HUB_A}', 'DANSOMAN', 'Dansoman', 'ACCRA_TEMA')`,
      update: `update service_zone set name = 'Renamed'`,
      remove: 'delete from service_zone',
    },
    service_zone_alias: {
      insert: `insert into service_zone_alias (id, hub_id, zone_id, alias, kind) values (gen_random_uuid(), '${HUB_A}', '${ZONE_A}', 'tema station', 'LANDMARK')`,
      update: `update service_zone_alias set alias = 'renamed'`,
      remove: 'delete from service_zone_alias',
    },
    hub_setting: {
      insert: `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by) values (gen_random_uuid(), '${HUB_A}', 'station_drop_fee', '', 2, '2100', 'pesewas', now(), '${ACTOR}')`,
      update: `update hub_setting set value = '9999'`,
      remove: 'delete from hub_setting',
    },
  } as const;

  // Break caught: a grant that lets the API write a table only a seed fills, under any context, the staff and the capabilities included.
  it.each(TABLES)('refuses the API runtime any write to %s under every context', async (table) => {
    const contexts = [
      staffContext([HUB_A, HUB_B], 'ALL'),
      systemContext('configuration'),
      systemContext('authentication'),
      vendorContext(VENDOR_1),
    ];
    for (const context of contexts) {
      for (const kind of ['insert', 'update', 'remove'] as const) {
        expect(
          await runtimeState(context, statements[table][kind]),
          `${table} ${kind} as ${context.principalType}`,
        ).toBe('42501');
      }
    }
  });

  // Break caught: a trigger that is missing or lets an owner or administrator rewrite a version a charge has snapshotted.
  it.each(TABLES)('refuses every login an update or a delete of a row of %s', async (table) => {
    await withClient(database.urlFor('postgres'), async (admin) => {
      expect(await sqlState(admin, statements[table].update)).toBe('42501');
      expect(await sqlState(admin, statements[table].remove)).toBe('42501');
    });
  });
});

describe('what the tables refuse (constraints bind every login)', () => {
  const admin = async (statement: string): Promise<string | undefined> =>
    withClient(database.urlFor('postgres'), (client) => sqlState(client, statement));

  // Break caught: a second version 1 of one setting for one hub and scope, which would make "the value in force" ambiguous.
  it('holds one row per hub, key, scope and version', async () => {
    expect(
      await admin(
        `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
         values (gen_random_uuid(), '${HUB_A}', 'station_drop_fee', '', 1, '1', 'pesewas', now(), '${ACTOR}')`,
      ),
    ).toBe('23505');
  });

  // Break caught: a setting for a hub that does not exist, or a malformed key, scope or version.
  it('refuses a setting of an unknown hub and one with a malformed key, scope or version', async () => {
    const row = (hub: string, key: string, scope: string, version: number) =>
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
       values (gen_random_uuid(), '${hub}', '${key}', '${scope}', ${String(version)}, '1', 'pesewas', now(), '${ACTOR}')`;
    expect(await admin(row('99999999-9999-4999-8999-999999999999', 'k', '', 1))).toBe('23503');
    expect(await admin(row(HUB_A, '1bad', '', 1))).toBe('23514');
    expect(await admin(row(HUB_A, 'good_key', 'lower', 1))).toBe('23514');
    expect(await admin(row(HUB_A, 'good_key', '', 0))).toBe('23514');
  });

  // Break caught: an alias that is not in its normalised form (so a lookup could be fuzzy), one in the wrong hub for its zone, and one
  // that two zones of a hub would share (an ambiguity the data itself created).
  it('keeps an alias normalised, in its zone’s hub, and unique within its hub', async () => {
    const alias = (hub: string, zone: string, text: string) =>
      `insert into service_zone_alias (id, hub_id, zone_id, alias, kind) values (gen_random_uuid(), '${hub}', '${zone}', '${text}', 'AREA')`;
    expect(await admin(alias(HUB_A, ZONE_A, 'Community 1 '))).toBe('23514');
    expect(await admin(alias(HUB_A, ZONE_A, 'two  spaces'))).toBe('23514');
    expect(await admin(alias(HUB_A, ZONE_A, ''))).toBe('23514');
    expect(await admin(alias(HUB_A, ZONE_B, 'elsewhere'))).toBe('23503');
    expect(await admin(alias(HUB_A, ZONE_A, 'community 1'))).toBe('23505');
  });

  // Break caught: a service area outside the three, or a zone code outside its grammar.
  it('keeps a zone to a known service area and a stable code', async () => {
    const zone = (code: string, area: string) =>
      `insert into service_zone (id, hub_id, code, name, service_area) values (gen_random_uuid(), '${HUB_A}', '${code}', 'N', '${area}')`;
    expect(await admin(zone('NEW_ZONE', 'MOON'))).toBe('23514');
    expect(await admin(zone('lower', 'ACCRA_TEMA'))).toBe('23514');
    expect(await admin(zone('TEMA', 'ACCRA_TEMA'))).toBe('23505');
  });
});

describe('melarc.seed_hub_configuration, the one way in', () => {
  let seeded: TestDatabase;

  beforeAll(async () => {
    seeded = await createTestDatabase();
    await withClient(seeded.urlFor('postgres'), async (admin) => {
      await admin.query(
        `insert into hub (id, name) values ('${HUBS[0]?.id ?? ''}', '${HUBS[0]?.name ?? ''}')`,
      );
    });
  });

  afterAll(async () => {
    await seeded.drop();
  });

  // Break caught: the plan and the function disagreeing about a table or a column, or a seed that writes fewer rows than it plans.
  it('seeds the launch hub’s zones and settings, as the provisioning login, and reports what it inserted', async () => {
    const { service, close } = buildService(seeded, { login: PROVISIONING_ROLE });
    try {
      const report = await runSeed(service, hubConfigurationPlan());
      expect(report).toEqual({
        service_zone: SERVICE_ZONES.length,
        hub_setting: HUB_SETTINGS.length,
      });
    } finally {
      await close();
    }
    await withClient(seeded.urlFor('postgres'), async (admin) => {
      expect(await scalar<number>(admin, 'select count(*)::int from service_zone')).toBe(7);
      expect(await scalar<number>(admin, 'select count(*)::int from service_zone_alias')).toBe(0);
      // Every setting is version 1, entered by the reserved system actor, effective from the seed transaction's own time.
      expect(
        await scalar<number>(
          admin,
          `select count(*)::int from hub_setting
            where version = 1 and created_by = '${ACTOR}' and effective_from <= now() and hub_id = '${LAUNCH_HUB_ID}'`,
        ),
      ).toBe(HUB_SETTINGS.length);
    });
  });

  // Break caught: a second seed adding a second copy, or changing what a charge may already have snapshotted. The plan is once.
  it('refuses to seed again and leaves the rows as they were', async () => {
    const { service, close } = buildService(seeded, { login: PROVISIONING_ROLE });
    try {
      const failure = await runSeed(service, hubConfigurationPlan()).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SeedRefusedError);
      expect((failure as SeedRefusedError).table).toBe('service_zone');
    } finally {
      await close();
    }
    await withClient(seeded.urlFor('postgres'), async (admin) => {
      expect(await scalar<number>(admin, 'select count(*)::int from hub_setting')).toBe(
        HUB_SETTINGS.length,
      );
    });
  });

  // Break caught: a login other than the provisioning one executing the function (the API runtime asserts the seed label and holds
  // no EXECUTE), and a plan for a hub that does not exist.
  it('is executable by the provisioning login only', async () => {
    await withClient(seeded.urlFor('melarc_api_runtime'), async (client) => {
      expect(await sqlState(client, `select melarc.seed_hub_configuration('{}'::jsonb)`)).toBe(
        '42501',
      );
    });
  });

  it('refuses a plan for a hub that does not exist, and a malformed payload, writing nothing', async () => {
    const empty = await createTestDatabase();
    try {
      const { service, close } = buildService(empty, { login: PROVISIONING_ROLE });
      try {
        const plan = hubConfigurationPlan();
        const unknownHub = await runSeed(service, plan).catch((error: unknown) => error);
        expect(serverErrorIn(unknownHub)?.code).toBe('23503');
        const malformed = await runSeed(service, {
          ...plan,
          payload: { ...plan.payload, extra: [{ a: 1 }] },
        }).catch((error: unknown) => error);
        expect(serverErrorIn(malformed)?.code).toBe('22023');
      } finally {
        await close();
      }
      await withClient(empty.urlFor('postgres'), async (admin) => {
        for (const table of TABLES) {
          expect(await scalar<number>(admin, `select count(*)::int from ${table}`), table).toBe(0);
        }
      });
    } finally {
      await empty.drop();
    }
  });
});
