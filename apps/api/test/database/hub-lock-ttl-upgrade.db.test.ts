import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { HUB_SETTINGS } from '../../src/tools/seed/hub-configuration.js';
import { builtBefore, type Built } from './support/history-before.js';
import { HUB_A } from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';

/**
 * The upgrade to migration 0098 (the audit of 15 November 2026, point 3): the receive lock's idle time for a hub that was configured before the setting existed.
 *
 * The hub's configuration is seeded **once** (`melarc.seed_hub_configuration` refuses a second run), so a database seeded before `intake_lock_idle_ttl_minutes` was added to the plan never
 * received it, the lookup answers NULL, and a hub with no usable idle time offers no takeover at all: a lock held by someone who has left stays theirs for ever. A fresh test database behaves
 * correctly (it is seeded from the current plan), so this builds the database the way a persistent one was **before** the migration (the history through 0097, applied by the real runner) and takes it
 * through the upgrade. Each claim:
 *
 * - **Before the upgrade the abandoned lock cannot be taken over**, and the idle time answers nothing (the premise: the defect is observed, not assumed).
 * - **The upgrade gives a configured hub the approved value** (the seed's own: a test holds the two together) as a new row of the hub's configuration, by the system, in the hub's company-wide scope.
 * - **It preserves every explicit configuration**: a hub that has a row of its own for the key, a usable one or not, is left exactly as it is (nothing is invented over it), and a hub with no
 *   configuration at all is left without any, so that the seed can still run on it.
 * - **After the upgrade the same abandoned lock is eligible for takeover**, by another receiver, through the guard the application meets.
 */
const HUB_UNSET = '22222222-2222-4222-8222-222222222222';
const HUB_EXPLICIT = '33333333-3333-4333-8333-333333333333';
const HUB_UNUSABLE = '44444444-4444-4444-8444-444444444444';
const KEY = 'intake_lock_idle_ttl_minutes';
const COUNT = 'hub.intake.count';

let built: Built;
let app: BuiltService;

const staff = (key: string, hub: string): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [hub],
  correlationId: 'hub-lock-ttl-upgrade',
});

type Result = { readonly rows: unknown[] } | { readonly code: string | undefined };

/** What a statement does as a staff context of the application's login: the rows it returned, or the SQLSTATE the database raised. */
async function attempt(context: SecurityContext, text: string): Promise<Result> {
  try {
    const rows = await app.service.transactionWithContext(
      context,
      async (tx) => (await tx.execute(sql.raw(text))).rows,
    );
    return { rows };
  } catch (error) {
    return { code: serverErrorIn(error)?.code ?? 'other' };
  }
}

async function idleTimeOf(hub: string): Promise<unknown> {
  const answer = await attempt(
    staff(COUNT, hub),
    `select melarc.intake_lock_idle_ttl_minutes('${hub}') as minutes`,
  );
  if (!('rows' in answer))
    throw new Error(`the idle time was refused: ${answer.code ?? 'no code'}`);
  return (answer.rows[0] as { minutes: unknown }).minutes;
}

async function settingsOf(hub: string, key?: string) {
  return (
    await built.admin.query<{
      setting_key: string;
      scope_ref: string;
      version: number;
      value: unknown;
      unit: string;
      created_by: string;
    }>(
      `select setting_key, scope_ref, version, value, unit, created_by from hub_setting where hub_id = $1 ${key === undefined ? '' : 'and setting_key = $2'} order by setting_key, version`,
      key === undefined ? [hub] : [hub, key],
    )
  ).rows;
}

const insertSetting = (hub: string, key: string, value: unknown, unit: string) =>
  built.admin.query(
    `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
     values (gen_random_uuid(), $1, $2, '', 1, $3::jsonb, $4, now() - interval '1 day', $5)`,
    [hub, key, JSON.stringify(value), unit, randomUUID()],
  );

const code = (): string =>
  `ACC-IN-${randomUUID()
    .replaceAll(/[^2-9A-HJKMNP-Z]/gi, '')
    .toUpperCase()
    .padEnd(6, 'K')
    .slice(0, 6)}`;

/** An intake of the hub that is waiting for its count and whose lock its holder took `minutes` ago, arranged as the administrator with the guards off for the statement (as the tests of the lock do). */
async function lockedIntake(hub: string, holder: string, minutes: number): Promise<string> {
  const id = randomUUID();
  await built.admin.query('begin');
  try {
    await built.admin.query('set local session_replication_role = replica');
    await built.admin.query(
      `insert into pickup_intake (id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, declaration_captured_at, rider_declared_count, prefilled_count, active_receiver_id, lock_acquired_at)
       values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now() - interval '1 hour', 3, 3, $4, now() - make_interval(mins => $5))`,
      [id, code(), hub, holder, minutes],
    );
    await built.admin.query('commit');
  } catch (error) {
    await built.admin.query('rollback');
    throw error;
  }
  return id;
}

/** The act on the lock as the application writes it: the two columns, in the receiver's own name. */
const takeOver = (id: string, receiver: string): string =>
  `update pickup_intake set active_receiver_id = '${receiver}', lock_acquired_at = now() where id = '${id}' returning id`;

const holderOf = async (id: string): Promise<string | null> =>
  (
    await built.admin.query<{ active_receiver_id: string | null }>(
      `select active_receiver_id from pickup_intake where id = $1`,
      [id],
    )
  ).rows[0]?.active_receiver_id ?? null;

const UPGRADE_FROM = 98;
let abandoned: string;
let holder: string;

beforeAll(async () => {
  built = await builtBefore(UPGRADE_FROM);
  app = buildService(built.target);
  for (const [hub, name] of [
    [HUB_UNSET, 'Hub with no configuration'],
    [HUB_EXPLICIT, 'Hub with its own value'],
    [HUB_UNUSABLE, 'Hub with an unusable value'],
  ] as const) {
    await built.admin.query(`insert into hub (id, name) values ($1, $2)`, [hub, name]);
  }
  // The configuration as it was seeded before the setting existed: other settings, and none for the key.
  for (const hub of [HUB_A, HUB_EXPLICIT, HUB_UNUSABLE]) {
    await insertSetting(hub, 'auto_reschedule', false, 'switch');
    await insertSetting(hub, 'stale_failure_backstop_hours', 24, 'hours');
  }
  // Two hubs that already have a row of their own for the key: a usable value that is not the default, and one that is no number of minutes.
  await insertSetting(HUB_EXPLICIT, KEY, 30, 'minutes');
  await insertSetting(HUB_UNUSABLE, KEY, 'soon', 'minutes');
  holder = randomUUID();
  abandoned = await lockedIntake(HUB_A, holder, 120);
}, 180_000);

afterAll(async () => {
  await app.close();
  await built.done();
});

describe('the receive lock’s idle time for a hub configured before the setting existed (the audit of 15 November 2026, point 3)', () => {
  // Break caught: a premise assumed and not seen: that a database seeded before the setting offers no takeover, so that the lock of someone who has left stays theirs.
  it('before the upgrade: the hub has no idle time and an abandoned lock cannot be taken over', async () => {
    expect(await settingsOf(HUB_A, KEY)).toEqual([]);
    expect(await idleTimeOf(HUB_A)).toBeNull();
    const other = staff(COUNT, HUB_A);
    const refused = await attempt(other, takeOver(abandoned, other.principalId));
    expect('code' in refused ? refused.code : 'taken').toBe('23514');
    expect(await holderOf(abandoned)).toBe(holder);
  });

  // Break caught: an upgrade that gives nobody the value (the lock stays theirs), that overwrites what a hub has set, that gives a hub the owner never configured a row the seed would then refuse over,
  // that gives a value other than the approved one, or one that is a second version where there was none.
  it('the upgrade gives a configured hub the approved value, keeps every explicit configuration, and leaves an unconfigured hub unconfigured', async () => {
    const approved = HUB_SETTINGS.find((setting) => setting.key === KEY);
    expect(approved).toBeDefined();
    const before = {
      explicit: await settingsOf(HUB_EXPLICIT),
      unusable: await settingsOf(HUB_UNUSABLE),
    };

    await runMigrations({ url: built.target.urlFor(MIGRATION_ROLE), folder: MIGRATIONS_FOLDER });

    const given = await settingsOf(HUB_A, KEY);
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({
      scope_ref: '',
      version: 1,
      value: approved?.value,
      unit: approved?.unit,
    });
    const system = (
      await built.admin.query<{ id: string }>(`select melarc.reserved_system_actor_id() as id`)
    ).rows[0]?.id;
    expect(given[0]?.created_by).toBe(system);
    // The other settings of the hub are as they were.
    expect((await settingsOf(HUB_A)).map((row) => row.setting_key)).toEqual([
      'auto_reschedule',
      'intake_lock_idle_ttl_minutes',
      'stale_failure_backstop_hours',
    ]);
    // What a hub set for itself stands, exactly, a usable value or not; and a hub with no configuration at all still has none.
    expect(await settingsOf(HUB_EXPLICIT)).toEqual(before.explicit);
    expect(await settingsOf(HUB_UNUSABLE)).toEqual(before.unusable);
    expect(await settingsOf(HUB_UNSET)).toEqual([]);
    expect(await idleTimeOf(HUB_EXPLICIT)).toBe(30);
    expect(await idleTimeOf(HUB_UNUSABLE)).toBeNull();
  });

  // Break caught: a value that is in the table and not in force (the lookup reads another scope, another key or a time in the future), and a lock that is still not eligible.
  it('after the upgrade: the idle time is in force, and the same abandoned lock is taken over by another receiver', async () => {
    expect(await idleTimeOf(HUB_A)).toBe(15);
    const other = staff(COUNT, HUB_A);
    const taken = await attempt(other, takeOver(abandoned, other.principalId));
    expect('rows' in taken).toBe(true);
    expect(await holderOf(abandoned)).toBe(other.principalId);
    // A lock held for five minutes is not abandoned: the value is the approved fifteen, not zero.
    const fresh = await lockedIntake(HUB_A, holder, 5);
    const early = staff(COUNT, HUB_A);
    const refused = await attempt(early, takeOver(fresh, early.principalId));
    expect('code' in refused ? refused.code : 'taken').toBe('23514');
    expect(await holderOf(fresh)).toBe(holder);
  });
});
