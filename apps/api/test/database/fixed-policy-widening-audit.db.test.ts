import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { seedReferenceData } from './support/seeded.js';
import {
  clientFor,
  createTestDatabase,
  sqlState,
  type TestDatabase,
} from './support/test-database.js';

/**
 * The widening of a fixed Vendor or Rider policy is on record (task A3.4 of the audit follow-up, the Product Owner's decision of 7 November 2026; migration
 * `0079`; audit.md section 5.6, "Facts of `permission.fixed_policy.widened`"). `melarc.change_fixed_policy` (0017) recorded a reduction, by the sessions it
 * ends, and a widening nowhere; it now writes one enhanced event for a widening, in the transaction of the change, by the system, and for no reduction. Called
 * as the migration login, the one identity that may; read as the administrator, who bypasses row-level security.
 *
 * A clean install is enough here: the function is replaced by a migration the test database applies, and the widenings of 0043 are not recorded after the
 * fact (the migration says why: the revision of a fixed policy does not show that a widening happened on a database).
 */
let database: TestDatabase;
let admin: pg.Client;
let migration: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  migration = clientFor(database.urlFor(MIGRATION_ROLE));
  await migration.connect();
});

afterAll(async () => {
  await migration.end();
  await admin.end();
  await database.drop();
});

interface PolicyRow {
  readonly revision: number;
  readonly minimum_revision: number;
}

const policyOf = async (audience: string): Promise<PolicyRow> => {
  const { rows } = await admin.query<PolicyRow>(
    `select revision, minimum_revision from fixed_permission_policy where principal_type = $1`,
    [audience],
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`no fixed policy for ${audience}`);
  return row;
};

interface EventRow {
  readonly event_code: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly surface_context: string;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly responsible_hub_id: string | null;
  readonly correlation_id: string;
  readonly related_ids: Record<string, unknown>;
  readonly before_after: Record<string, unknown>;
  readonly detail: Record<string, unknown>;
  readonly outcome: string;
  readonly enhanced: boolean;
}

const eventsOf = async (code: string, label: string): Promise<EventRow[]> =>
  (
    await admin.query<EventRow>(
      `select event_code, actor_type, actor_id, surface_context, object_type, object_id, responsible_hub_id, correlation_id,
              related_ids, before_after, detail, outcome, enhanced
         from audit_event where event_code = $1 and correlation_id = $2 order by recorded_at, id`,
      [code, label],
    )
  ).rows;

const change = async (audience: string, reduction: boolean, label: string) =>
  (
    await migration.query<{ result: { kind: string; revision: number; minimum_revision: number } }>(
      `select melarc.change_fixed_policy($1, $2, $3) as result`,
      [audience, reduction, label],
    )
  ).rows[0]?.result;

describe('a widening of a fixed policy', () => {
  // Break caught (A3.4): a widening that leaves no event (the state until 0079), one that is written as an ordinary event, as the act of a person or of a hub, with
  // an identifier the policy does not have, with the wrong audience or revision, or with no before and after of the revision; and a widening that moves the minimum.
  it.each(['VENDOR', 'RIDER'] as const)(
    'writes one enhanced permission.fixed_policy.widened for the %s, by the system, with the audience, the revision and its before and after',
    async (audience) => {
      const before = await policyOf(audience);
      const label = `release-test#widen-${audience.toLowerCase()}`;

      const result = await change(audience, false, label);

      expect(result).toMatchObject({
        kind: 'ADDITION',
        revision: before.revision + 1,
        minimum_revision: before.minimum_revision,
      });
      expect(await policyOf(audience)).toEqual({
        revision: before.revision + 1,
        minimum_revision: before.minimum_revision,
      });
      const [event, ...more] = await eventsOf('permission.fixed_policy.widened', label);
      expect(more, 'exactly one event').toEqual([]);
      expect(event).toMatchObject({
        event_code: 'permission.fixed_policy.widened',
        actor_type: 'SYSTEM',
        actor_id: null,
        surface_context: 'SYSTEM',
        object_type: 'FixedPermissionPolicy',
        object_id: null,
        responsible_hub_id: null,
        correlation_id: label,
        outcome: 'SUCCEEDED',
        enhanced: true,
        detail: {},
      });
      expect(event?.related_ids).toEqual({
        principal_type: audience,
        revision: before.revision + 1,
        minimum_revision: before.minimum_revision,
      });
      expect(event?.before_after).toEqual({
        revision: { before: before.revision, after: before.revision + 1 },
      });
    },
  );

  // Break caught: the event written for a change that did not happen (a refusal that rolls back and leaves the event, which an append-only ledger could not
  // take back), or a refused call that still raised the revision.
  it.each([
    ['an audience that has no fixed policy', 'STAFF', false, 'release-test#none', '22023'],
    ['a correlation id that is not one', 'VENDOR', false, '', '22023'],
    ['no statement of whether it reduces', 'VENDOR', null, 'release-test#null', '22023'],
  ] as const)(
    'writes no event and changes nothing for %s',
    async (_what, audience, reduction, label, state) => {
      const before = await policyOf('VENDOR');

      expect(
        await sqlState(
          migration,
          `select melarc.change_fixed_policy('${audience}', ${reduction === null ? 'null' : String(reduction)}, '${label}')`,
        ),
      ).toBe(state);

      expect(await policyOf('VENDOR')).toEqual(before);
      expect(await eventsOf('permission.fixed_policy.widened', label)).toEqual([]);
    },
  );

  // Break caught: the settings of the function left behind on the connection (the principal and the capability it asserts for its own statements), which
  // would give the next statement of the migration login a capability it did not ask for.
  it('puts back the principal and the capability it asserted', async () => {
    await change('VENDOR', false, 'release-test#settings');

    const { rows } = await migration.query<{ principal: string | null; capability: string | null }>(
      `select current_setting('melarc.principal_type', true) as principal, current_setting('melarc.task_capability', true) as capability`,
    );
    expect(rows[0]?.principal ?? '').toBe('');
    expect(rows[0]?.capability ?? '').toBe('');
  });
});

describe('a reduction of a fixed policy', () => {
  // Break caught: a reduction that is recorded as a widening (the event says the authority grew when it shrank), or a reduction whose own effect changed (the
  // minimum not raised to the new revision, the revision not raised). The sessions it ends are held by policy-change.db.test.ts, unchanged.
  it('raises the revision and the minimum as before and writes no permission.fixed_policy.widened', async () => {
    const before = await policyOf('RIDER');
    const label = 'release-test#reduce-rider';

    const result = await change('RIDER', true, label);

    expect(result).toMatchObject({
      kind: 'REDUCTION',
      revision: before.revision + 1,
      minimum_revision: before.revision + 1,
    });
    expect(await policyOf('RIDER')).toEqual({
      revision: before.revision + 1,
      minimum_revision: before.revision + 1,
    });
    expect(await eventsOf('permission.fixed_policy.widened', label)).toEqual([]);
  });
});

describe('the object types of the ledger', () => {
  const insert = (objectType: string) =>
    admin.query(
      `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id, correlation_id,
                                detail, outcome, enhanced, serialisation_version)
       values (gen_random_uuid(), 'permission.fixed_policy.widened', now(), 'SYSTEM', null, 'SYSTEM', $1, null, 'release-test#type',
               '{}'::jsonb, 'SUCCEEDED', true, 1)`,
      [objectType],
    );

  // Break caught: the CHECK of the closed set not widened by the migration (the function would then fail on its own insert), or widened to anything.
  it('admit FixedPermissionPolicy and still refuse a type that is not in the set', async () => {
    await expect(insert('FixedPermissionPolicy')).resolves.toBeDefined();

    await expect(insert('FixedPolicy')).rejects.toMatchObject({ code: '23514' });
  });
});
