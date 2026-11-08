import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import { runSeed } from '../../src/platform/database/seed/seed-helper.js';
import { ConfigurationReader } from '../../src/platform/settings/configuration-reader.js';
import { HubSettingMissingError } from '../../src/platform/settings/hub-configuration.js';
import { SettingMissingError } from '../../src/platform/settings/settings-reader.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import {
  LAUNCH_HUB_ID,
  SERVICE_ZONES,
  hubConfigurationPlan,
} from '../../src/tools/seed/hub-configuration.js';
import { HUB_B } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { createTestDatabase, withClient, type TestDatabase } from './support/test-database.js';

/**
 * S1.4's reader against a real PostgreSQL: the configuration of one hub at one instant, read as the API runtime under the
 * `configuration` capability. The seeded launch hub is the data; the second hub has none, and a later version is added by the
 * cluster administrator (a seed is once, so a version is a row someone else enters).
 */

const ACTOR = '5eed0000-0000-4000-8000-0000000000a1';
/**
 * An instant after the seed and before the later version. The seed stamps its own transaction time, which is the day the test runs, so a
 * fixed date of the day the test was written (29 October 2026) fell before the seed the day after and the launch hub had no value in force:
 * the instant is placed between the seed and FUTURE, whatever the day, and a run in 2098 is the one that must change it.
 */
const NOW = new Date('2098-06-01T00:00:00Z');
const FUTURE = '2099-01-01T00:00:00Z';

let database: TestDatabase;
let reader: ConfigurationReader;
let close: () => Promise<void>;

beforeAll(async () => {
  database = await createTestDatabase();
  await withClient(database.urlFor('postgres'), async (admin) => {
    await admin.query(
      `insert into hub (id, name) values ('${HUBS[0]?.id ?? ''}', 'Accra'), ('${HUB_B}', 'Other')`,
    );
    await admin.query(
      `insert into setting (key, scope, value_type, value, unit, description) values
         ('liability_cap_amount', 'COMPANY', 'integer', '30000', 'pesewas', 'The cap'),
         ('rate_limit_staff_signin', 'PLATFORM', 'object', '{}', 'requests', 'A security parameter')`,
    );
  });
  const seeding = buildService(database, { login: PROVISIONING_ROLE });
  try {
    await runSeed(seeding.service, hubConfigurationPlan());
  } finally {
    await seeding.close();
  }
  // The seed stamps its own transaction time; a version of the same value at a later date is entered by the administrator.
  await withClient(database.urlFor('postgres'), async (admin) => {
    await admin.query(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
       values (gen_random_uuid(), '${LAUNCH_HUB_ID}', 'station_drop_fee', '', 2, '2500', 'pesewas', '${FUTURE}', '${ACTOR}')`,
    );
  });
  const built = buildService(database);
  close = built.close;
  reader = new ConfigurationReader(built.service);
});

afterAll(async () => {
  await close();
  await database.drop();
});

describe('the instant a value is in force at', () => {
  // Break caught (found by a test kit whose manual clock sat before the seed): the application's clock deciding what is in force, when the
  // database's clock stamped when it began. A value entered a moment ago is in force now, whatever time the application believes it is,
  // and one that takes effect in the future is not.
  it('is the database’s, by default: what the seed stamped is in force, and a future version is not', async () => {
    const config = await reader.forHub(LAUNCH_HUB_ID);
    expect(config.baseFee('ACCRA_TEMA').value.amountMinor).toBe(3500);
    expect(config.money('station_drop_fee').value).toBe(2000);
    expect(Math.abs(config.at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('can be asked at another instant, and then reads that instant’s versions', async () => {
    expect(
      (await reader.forHub(LAUNCH_HUB_ID, new Date('2099-06-01T00:00:00Z'))).money(
        'station_drop_fee',
      ).value,
    ).toBe(2500);
  });
});

describe('the launch hub, as the seed left it', () => {
  // Break caught: the snapshot not carrying the hub's name, which a vendor session (that may read no hub) needs for the hub code of an
  // operational code, or carrying another hub's.
  it('carries the name of the hub it is for, and of no other', async () => {
    expect((await reader.forHub(LAUNCH_HUB_ID, NOW)).hubName).toBe('Accra');
    expect((await reader.forHub(HUB_B, NOW)).hubName).toBe('Other');
  });

  // Break caught: the reader and the seed disagreeing about a column, so that a value the owner gave is not the value a charge reads.
  it('reads the seven zones and the fees the owner confirmed, with where each came from', async () => {
    const config = await reader.forHub(LAUNCH_HUB_ID, NOW);
    expect(config.zones.map((zone) => zone.code)).toEqual(
      SERVICE_ZONES.map((zone) => zone.code).toSorted(),
    );
    expect(config.aliases).toEqual([]);
    expect(config.baseFee('ACCRA_TEMA').value.days).toHaveLength(6);
    expect(config.baseFee('KASOA_CORRIDOR')).toMatchObject({
      value: { amountMinor: 3500, days: ['FRI'] },
      reference: {
        hubId: LAUNCH_HUB_ID,
        settingKey: 'service_area_base_fee',
        scopeRef: 'KASOA_CORRIDOR',
        effectiveVersion: 1,
      },
    });
    expect(config.corridorOffDayFee('AMASAMAN_ENVIRONS').value).toBe(7000);
    expect(config.corridorOffDayFee('KASOA_CORRIDOR').value).toBe(8000);
    expect(config.sizeClassSurcharges().value).toEqual({ SMALL: 0, MEDIUM: 2000, LARGE: 3000 });
    expect(config.timeOfDay('booking_cutoff_time').value.minutesSinceMidnight).toBe(600);
  });

  // Break caught: a value read as of the wrong instant. A later version must not alter an earlier snapshot, and must apply from its date.
  it('reads the version in force at the instant asked, and no later one', async () => {
    const before = await reader.forHub(LAUNCH_HUB_ID, NOW);
    expect(before.money('station_drop_fee')).toMatchObject({
      value: 2000,
      reference: { effectiveVersion: 1 },
    });
    const after = await reader.forHub(LAUNCH_HUB_ID, new Date('2099-06-01T00:00:00Z'));
    expect(after.money('station_drop_fee')).toMatchObject({
      value: 2500,
      reference: { effectiveVersion: 2 },
    });
  });

  // Break caught: a snapshot taken before the seed finding values that did not yet exist, or borrowing them.
  it('has no value in force before the seed, and says so rather than inventing one', async () => {
    const config = await reader.forHub(LAUNCH_HUB_ID, new Date('2000-01-01T00:00:00Z'));
    expect(config.find('station_drop_fee')).toBeUndefined();
    expect(() => config.money('station_drop_fee')).toThrow(HubSettingMissingError);
    expect(config.zones).toHaveLength(7);
  });
});

describe('another hub', () => {
  // Break caught: the first hub’s fees reaching the second (§33.4: a hub missing a fee fails visibly, it never borrows).
  it('sees none of the launch hub’s zones or values, and its missing fee is SETTING_MISSING', async () => {
    const config = await reader.forHub(HUB_B, NOW);
    expect(config.zones).toEqual([]);
    expect(config.aliases).toEqual([]);
    expect(() => config.money('station_drop_fee')).toThrow(HubSettingMissingError);
    expect(() => config.baseFee('ACCRA_TEMA')).toThrow(SettingMissingError);
  });
});

describe('the company rules', () => {
  // Break caught: the capability reading a security parameter, or failing to read the business rule it exists for.
  it('reads a company rule, and a platform setting is as if it did not exist', async () => {
    const config = await reader.forHub(LAUNCH_HUB_ID, NOW);
    expect(config.companyMoney('liability_cap_amount')).toBe(30000);
    expect(() => config.companyMoney('rate_limit_staff_signin')).toThrow(SettingMissingError);
  });
});
