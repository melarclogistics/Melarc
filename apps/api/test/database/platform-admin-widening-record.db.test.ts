import { rmSync } from 'node:fs';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAuditRecord } from '../../src/platform/audit/audit-record.js';
import type {
  AuditEventInput,
  AuditJsonObject,
  AuditScalar,
} from '../../src/platform/auth/ports/audit-writer.port.js';
import { AUTHENTICATION_PRINCIPAL_ID } from '../../src/platform/auth/sessions/session-parameters.js';
import { runSeed } from '../../src/platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import { runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  BUNDLE_IDS,
  GRANTS,
  NOTIFICATION_READ_GRANTS,
  SLICE_000_GRANTS,
  SLICE_001_GRANTS,
  type GrantSeed,
} from '../../src/tools/seed/bundles.js';
import { referenceSeedPlan } from '../../src/tools/seed/reference-seed.js';
import { applyMigration, seedEarlierContent } from './support/earlier-seed.js';
import { historyBefore, type Built } from './support/history-before.js';
import { insertSessionRow, OPS_STAFF_SNAPSHOT, sessionRow } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * Audit finding A3 (7 November 2026; `AC-SLICE-001-84`, `AC-SLICE-001-85`; migration 0078): the widening of the Platform Admin's grants by
 * migrations 0075 and 0077 was made under the bundle-change primitive of 0017, which recorded a reduction and no addition, so it left no event.
 * Migration 0078 puts it on record, for a database that holds it, and for no other.
 *
 * Each case builds a database **as the history left it before 0078** with the real runner (`historyBefore`), seeds it the way a build of the time
 * seeded it, takes it through the release steps that followed the seed with the migration files, one at a time, under the primitive of the time,
 * and only then applies 0078. A clean install proves nothing about this path (MIGRATION_AND_SEEDING.md section 5.5).
 *
 * - **The owner's database** (seeded 27 October 2026 with the SLICE-000 keys, then 0043, 0057, 0075 and 0077): both widenings are on record.
 * - **A database seeded between the two decisions** (the build of 0075, then 0077): the second alone.
 * - **A database seeded after both** (a new one, or the owner's re-created): nothing was widened on it, so nothing is recorded.
 * - **A history the arithmetic of 0078 does not describe**: a warning, and nothing is written for what cannot be shown.
 */
const STEP_0077 = '0077_platform_admin_device_replacement.sql';
const STEPS = [
  '0043_slice_001_grants.sql',
  '0057_notification_read_grant.sql',
  '0075_platform_admin_every_hub.sql',
  STEP_0077,
];
const RECORD_MIGRATION = '0078_bundle_widening_audit.sql';
const LABEL_0075 = 'release-p1#platform-admin-every-hub';
const LABEL_0077 = 'release-p1-1#platform-admin-device-replacement';
const REREGISTER = 'staff.device.reregister';
const PLATFORM_ADMIN = BUNDLE_IDS.platformAdmin;
const bundleIds = Object.values(BUNDLE_IDS);

/** The grants as the first lists wrote them: what a database seeded before the decisions of 5 and 6 November held after 0043 and 0057. */
const HISTORY: readonly GrantSeed[] = [
  ...SLICE_000_GRANTS,
  ...SLICE_001_GRANTS,
  ...NOTIFICATION_READ_GRANTS,
];
/** What a build seeded on 5 November 2026 (migration 0075 but not 0077): the Platform Admin at all hubs but for `staff.device.reregister`. */
const AFTER_0075: readonly GrantSeed[] = GRANTS.map((grant) =>
  grant.bundleId === PLATFORM_ADMIN && grant.permissionKey === REREGISTER
    ? { ...grant, hubScope: 'own' as const }
    : grant,
);
/** The Platform Admin's grants at its own hub as first written, by key: the 34 that 0075 and 0077 widened between them. */
const OWN_AS_WRITTEN = HISTORY.filter(
  (grant) => grant.bundleId === PLATFORM_ADMIN && grant.hubScope === 'own',
).toSorted((left, right) => (left.permissionKey < right.permissionKey ? -1 : 1));
const WIDENED_BY_0075 = OWN_AS_WRITTEN.filter((grant) => grant.permissionKey !== REREGISTER);
const WIDENED_BY_0077 = OWN_AS_WRITTEN.filter((grant) => grant.permissionKey === REREGISTER);

/** A grant as the event writes it: permission_key|hub_scope|ownership_scope|tier. */
const textOf = (grant: GrantSeed, hubScope: string): string =>
  [grant.permissionKey, hubScope, grant.ownershipScope, grant.tier ?? '-'].join('|');
const labelOf = (grant: GrantSeed): string =>
  [
    grant.bundleId,
    grant.permissionKey,
    grant.hubScope,
    grant.ownershipScope,
    grant.tier ?? '-',
  ].join('|');
const seedRow = (grant: GrantSeed) => ({
  bundle_id: grant.bundleId,
  permission_key: grant.permissionKey,
  hub_scope: grant.hubScope,
  ownership_scope: grant.ownershipScope,
  tier: grant.tier,
});

/** A seed of the build between the two decisions: the current reference data, with the grants as that build wrote them. */
async function seedAsOf0075(database: TestDatabase): Promise<void> {
  const { service, close } = buildService(database, { login: PROVISIONING_ROLE });
  try {
    const plan = referenceSeedPlan();
    await runSeed(service, {
      ...plan,
      payload: { ...plan.payload, role_bundle_grant: AFTER_0075.map(seedRow) },
    });
  } finally {
    await close();
  }
}

interface WideningEvent {
  readonly id: string;
  readonly event_code: string;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly actor_bundle: string | null;
  readonly surface_context: string;
  readonly device_context: unknown;
  readonly vendor_organization_id: string | null;
  readonly responsible_hub_id: string | null;
  readonly object_type: string;
  readonly object_id: string;
  readonly correlation_id: string;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly reason_code: string | null;
  readonly reason_label: string | null;
  readonly note: string | null;
  readonly approval_id: string | null;
  readonly before_after: { grants: { before: string[]; after: string[] } };
  readonly related_ids: Record<string, unknown>;
  readonly detail: Record<string, unknown>;
  readonly outcome: string;
  readonly enhanced: boolean;
  readonly serialisation_version: number;
}
const widenings = (observer: Observer): Promise<WideningEvent[]> =>
  observer.rows<WideningEvent>(
    `select * from audit_event where event_code = 'permission.bundle.widened' order by id`,
  );
const bundles = (observer: Observer) =>
  observer.rows<{ id: string; revision: number; reduction_floor: number }>(
    `select id, revision, reduction_floor from role_bundle order by id`,
  );
const grantsHeld = async (observer: Observer): Promise<string[]> =>
  (
    await observer.rows<{
      bundle_id: string;
      permission_key: string;
      hub_scope: string;
      ownership_scope: string;
      tier: string | null;
    }>(`select bundle_id, permission_key, hub_scope, ownership_scope, tier from role_bundle_grant`)
  )
    .map((row) =>
      [row.bundle_id, row.permission_key, row.hub_scope, row.ownership_scope, row.tier ?? '-'].join(
        '|',
      ),
    )
    .toSorted();
/** What the catalogue says of the primitive: owner, attributes, language, result and who may execute it. */
const primitiveOf = (observer: Observer) =>
  observer.one<Record<string, unknown>>(
    `select p.proowner::regrole::text as owner, p.prosecdef as definer, p.proconfig as config, l.lanname as language,
            pg_get_function_result(p.oid) as result, pg_get_function_identity_arguments(p.oid) as arguments,
            p.provolatile as volatility, coalesce(p.proacl::text, '') as acl
       from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = 'melarc.change_role_bundle(uuid,text,jsonb,text)'::regprocedure`,
  );

/** Every column of an event but its identity, its two instants and its detail: the part of it that a record made later must repeat. */
function stable(event: WideningEvent): Record<string, unknown> {
  const later = new Set(['id', 'occurred_at', 'recorded_at', 'detail']);
  return Object.fromEntries(Object.entries(event).filter(([column]) => !later.has(column)));
}

/** The event read back as the input of the audit writer: it must be accepted, with the facts the database wrote. */
function acceptedByTheWriter(event: WideningEvent): void {
  const input: AuditEventInput = {
    code: event.event_code,
    enhanced: event.enhanced,
    outcome: 'SUCCEEDED',
    object: { type: event.object_type, id: event.object_id },
    relatedIds: event.related_ids as AuditJsonObject,
    beforeAfter: event.before_after,
    detail: event.detail as Readonly<Record<string, AuditScalar>>,
  };
  const record = buildAuditRecord(
    input,
    {
      principalType: 'SYSTEM',
      principalId: AUTHENTICATION_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: event.correlation_id,
    },
    event.occurred_at,
    event.id,
  );
  expect(record).toMatchObject({
    eventCode: event.event_code,
    actorType: 'SYSTEM',
    actorId: null,
    surfaceContext: 'SYSTEM',
    objectType: 'RoleBundle',
    objectId: event.object_id,
    correlationId: event.correlation_id,
    outcome: 'SUCCEEDED',
    enhanced: true,
  });
  expect(record.beforeAfter).toEqual(event.before_after);
  expect(record.relatedIds).toEqual(event.related_ids);
  expect(record.detail).toEqual(event.detail);
}

/**
 * A database with the history before 0078 applied by the real runner, and nothing else in it. (`builtBefore` also inserts a hub for the upgrade
 * checks of the pickup tables, and the reference seed refuses a database that holds a row.)
 */
async function builtThrough0077(): Promise<Built> {
  const target = await createTestDatabase({ migrate: false });
  const folder = historyBefore(78);
  const admin = clientFor(target.urlFor('postgres'));
  try {
    await runMigrations({ url: target.urlFor(MIGRATION_ROLE), folder });
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => undefined);
    rmSync(folder, { recursive: true, force: true });
    await target.drop();
    throw error;
  }
  return {
    target,
    admin,
    folder,
    done: async () => {
      await admin.end();
      rmSync(folder, { recursive: true, force: true });
      await target.drop();
    },
  };
}

interface Upgraded {
  readonly built: Built;
  readonly migration: pg.Client;
  readonly observer: Observer;
  readonly notices: string[];
  close(): Promise<void>;
}

/**
 * A database as the history before 0078 left it, seeded by `seed`, taken through `steps` one file at a time under the primitive of that time.
 * The migration connection collects the notices of the server, so that a warning of 0078 can be read.
 */
async function upgraded(
  seed: (database: TestDatabase) => Promise<void>,
  steps: readonly string[],
): Promise<Upgraded> {
  const built = await builtThrough0077();
  const migration = clientFor(built.target.urlFor(MIGRATION_ROLE));
  const notices: string[] = [];
  migration.on('notice', (notice) => notices.push(notice.message ?? ''));
  let observer: Observer | undefined;
  try {
    await migration.connect();
    observer = await observe(built.target);
    await seed(built.target);
    for (const step of steps) await applyMigration(migration, step);
  } catch (error) {
    await observer?.close();
    await migration.end().catch(() => undefined);
    await built.done();
    throw error;
  }
  const watcher = observer;
  return {
    built,
    migration,
    observer: watcher,
    notices,
    close: async () => {
      await watcher.close();
      await migration.end();
      await built.done();
    },
  };
}

describe('the owner’s database: seeded before the decisions, then 0043, 0057, 0075 and 0077 under the primitive of 0017', () => {
  let world: Upgraded;
  let before: {
    bundles: Awaited<ReturnType<typeof bundles>>;
    grants: string[];
    primitive: Record<string, unknown> | undefined;
    sessionId: string;
  };
  let applied: number;

  beforeAll(async () => {
    world = await upgraded(seedEarlierContent, STEPS);
    // A live session of the Platform Admin, issued at revision 3 (between the two widenings); 0078 changes nothing about it.
    const session = await insertSessionRow(
      world.built.admin,
      sessionRow({ bundleId: PLATFORM_ADMIN, bundleRevision: 3, snapshot: OPS_STAFF_SNAPSHOT }),
    );
    before = {
      bundles: await bundles(world.observer),
      grants: await grantsHeld(world.observer),
      primitive: await primitiveOf(world.observer),
      sessionId: session.id,
    };
  });
  afterAll(async () => {
    await world.close();
  });

  // Break caught: a test arranged so that 0078 has nothing to find (a database the old primitive did not widen, or one the new primitive
  // already recorded): the case must start as the finding describes it, widened and with no record of it.
  it('starts as the finding describes it: the Platform Admin widened four times, and not one event of it', async () => {
    expect(before.bundles.find((row) => row.id === PLATFORM_ADMIN)).toEqual({
      id: PLATFORM_ADMIN,
      revision: 5,
      reduction_floor: 1,
    });
    expect(before.grants).toEqual(GRANTS.map(labelOf).toSorted());
    expect(await world.observer.count('audit_event')).toBe(0);
    // The primitive of 0017 is the one in force: an addition wrote nothing.
    expect(
      await world.observer.one(
        `select 1 from pg_proc where proname = 'change_role_bundle' and prosrc like '%permission.bundle.widened%'`,
      ),
    ).toBeUndefined();
  });

  describe('once migration 0078 is applied by the migrator', () => {
    beforeAll(async () => {
      applied = (await runMigrations({ url: world.built.target.urlFor(MIGRATION_ROLE) })).applied;
    });

    it('is the one migration the history had left to apply', () => {
      expect(applied).toBe(1);
    });

    // Break caught (the finding): the widening of 0075 left no event, or an event that names other grants than the ones it widened, another
    // label, a person for the actor, or the wrong revision. Every column is read, not only the ones the finding names.
    it('records the widening of 0075: the 33 grants as they were and as they are, with its label, at the revision it raised the bundle to', async () => {
      expect(WIDENED_BY_0075).toHaveLength(33);

      const [first] = await widenings(world.observer);

      expect(first).toMatchObject({
        event_code: 'permission.bundle.widened',
        enhanced: true,
        outcome: 'SUCCEEDED',
        actor_type: 'SYSTEM',
        actor_id: null,
        actor_bundle: null,
        surface_context: 'SYSTEM',
        responsible_hub_id: null,
        vendor_organization_id: null,
        device_context: null,
        object_type: 'RoleBundle',
        object_id: PLATFORM_ADMIN,
        correlation_id: LABEL_0075,
        previous_state: null,
        resulting_state: null,
        reason_code: null,
        reason_label: null,
        note: null,
        approval_id: null,
        serialisation_version: 1,
      });
      expect(first?.related_ids).toEqual({
        bundle_id: PLATFORM_ADMIN,
        revision: 4,
        reduction_floor: 1,
      });
      expect(first?.before_after).toEqual({
        grants: {
          before: WIDENED_BY_0075.map((grant) => textOf(grant, 'own')),
          after: WIDENED_BY_0075.map((grant) => textOf(grant, 'all')),
        },
      });
      expect(first?.detail).toEqual({
        bundle_name: 'Platform Admin',
        added: 0,
        widened: 33,
        widened_by_migration: '0075_platform_admin_every_hub',
        recorded_by_migration: '0078_bundle_widening_audit',
      });
    });

    it('records the widening of 0077: staff.device.reregister from own to all, with its label, at the revision it raised the bundle to', async () => {
      expect(WIDENED_BY_0077).toHaveLength(1);

      const second = (await widenings(world.observer))[1];

      expect(second).toMatchObject({
        event_code: 'permission.bundle.widened',
        enhanced: true,
        outcome: 'SUCCEEDED',
        actor_type: 'SYSTEM',
        actor_id: null,
        object_type: 'RoleBundle',
        object_id: PLATFORM_ADMIN,
        correlation_id: LABEL_0077,
      });
      expect(second?.related_ids).toEqual({
        bundle_id: PLATFORM_ADMIN,
        revision: 5,
        reduction_floor: 1,
      });
      expect(second?.before_after).toEqual({
        grants: {
          before: [`${REREGISTER}|own|any|P`],
          after: [`${REREGISTER}|all|any|P`],
        },
      });
      expect(second?.detail).toEqual({
        bundle_name: 'Platform Admin',
        added: 0,
        widened: 1,
        widened_by_migration: '0077_platform_admin_device_replacement',
        recorded_by_migration: '0078_bundle_widening_audit',
      });
    });

    // Break caught: an event for a bundle that was not widened (the arithmetic read as "every bundle"), a widening written twice, or the
    // records out of the order the steps happened in.
    it('writes one event for each widening, for the Platform Admin bundle alone, oldest first', async () => {
      const events = await widenings(world.observer);

      expect(events.map((event) => [event.object_id, event.correlation_id])).toEqual([
        [PLATFORM_ADMIN, LABEL_0075],
        [PLATFORM_ADMIN, LABEL_0077],
      ]);
      expect(await world.observer.count('audit_event')).toBe(2);
    });

    // Break caught: a record that is a change (a revision raised, a grant rewritten, a session ended or revoked) when it is meant to be a
    // statement about changes already made.
    it('changes no revision, no floor, no grant and no session', async () => {
      expect(await bundles(world.observer)).toEqual(before.bundles);
      expect(await grantsHeld(world.observer)).toEqual(before.grants);
      expect(
        await world.observer.one<{ terminated_at: Date | null }>(
          `select terminated_at from session where id = $1`,
          [before.sessionId],
        ),
      ).toEqual({ terminated_at: null });
      expect(
        await world.observer.count('audit_event', { event_code: 'auth.session.authority_revoked' }),
      ).toBe(0);
    });

    // Break caught: a replacement that drops the owner, the definer attribute, the fixed search_path or the narrow EXECUTE of the primitive
    // (a function recreated by another owner, or opened to PUBLIC), which is how a CREATE OR REPLACE goes wrong.
    it('leaves the primitive with the owner, the attributes and the EXECUTE grant it had, now writing the event of an addition', async () => {
      const after = await primitiveOf(world.observer);

      expect(after).toEqual(before.primitive);
      expect(after).toMatchObject({
        owner: 'melarc_owner',
        definer: true,
        config: ['search_path=pg_catalog, pg_temp'],
        language: 'plpgsql',
        result: 'jsonb',
      });
      expect(String(after?.acl)).not.toMatch(/(^|,)=/);
      expect(
        await world.observer.one(
          `select 1 from pg_proc where proname = 'change_role_bundle' and prosrc like '%permission.bundle.widened%'`,
        ),
      ).toBeDefined();
    });

    // Break caught: a second shape of the event (a column, a spelling, a fact the writer would refuse) that the ledger would then hold beside
    // the first.
    it('writes events the audit writer accepts', async () => {
      const events = await widenings(world.observer);
      expect(events).toHaveLength(2);
      for (const event of events) acceptedByTheWriter(event);
    });
  });
});

describe('the event 0078 writes is the event the primitive writes for the same change', () => {
  let world: Upgraded;
  let compared: TestDatabase;
  let observer: Observer;
  let migration: pg.Client;

  beforeAll(async () => {
    world = await upgraded(seedEarlierContent, STEPS);
    await applyMigration(world.migration, RECORD_MIGRATION);
  });
  // A hook of its own: each of the two databases takes most of a hook's time on a busy machine.
  beforeAll(async () => {
    // The same history on a database that holds 0078 already: the migration files are applied one at a time under the new primitive.
    compared = await createTestDatabase();
    migration = clientFor(compared.urlFor(MIGRATION_ROLE));
    await migration.connect();
    observer = await observe(compared);
    expect(await widenings(observer)).toEqual([]);
    expect(await observer.count('role_bundle')).toBe(0);
    await seedEarlierContent(compared);
    for (const step of STEPS) await applyMigration(migration, step);
  });
  afterAll(async () => {
    await observer.close();
    await migration.end();
    await compared.drop();
    await world.close();
  });

  // Break caught: the record and the primitive drifting apart in a column, a list, an order or a count, so that the ledger holds two
  // readings of one fact depending on whether the widening was made before 0078 or after it. Only the moment (not known to 0078) and the
  // two facts that say the record was written afterwards may differ.
  it.each([
    [LABEL_0075, '0075_platform_admin_every_hub'],
    [LABEL_0077, '0077_platform_admin_device_replacement'],
  ])(
    'is the same for %s, but for the instants and the two facts that say it was recorded afterwards',
    async (label, migrationName) => {
      const recorded = (await widenings(world.observer)).find(
        (event) => event.correlation_id === label,
      );
      const written = (await widenings(observer)).find(
        (event) => event.correlation_id === label && event.object_id === PLATFORM_ADMIN,
      );
      if (recorded === undefined || written === undefined) throw new Error(`no event for ${label}`);

      expect(stable(recorded)).toEqual(stable(written));
      expect(recorded.detail).toEqual({
        ...written.detail,
        widened_by_migration: migrationName,
        recorded_by_migration: '0078_bundle_widening_audit',
      });
      // Both are the database’s own instants.
      expect(recorded.occurred_at).toBeInstanceOf(Date);
      expect(written.occurred_at).toBeInstanceOf(Date);
    },
  );
});

describe('a database seeded between the two decisions: the build of 0075, then 0077', () => {
  let world: Upgraded;

  beforeAll(async () => {
    world = await upgraded(seedAsOf0075, [STEP_0077]);
    await applyMigration(world.migration, RECORD_MIGRATION);
  });
  afterAll(async () => {
    await world.close();
  });

  // Break caught: the widening of 0075 recorded for a database it never widened (the seed of its build already held the grants at all hubs),
  // which would state in an append-only ledger something that did not happen; and the one that did happen left out.
  it('records the widening of 0077 alone, at revision 2, and none of 0075', async () => {
    const bundleRow = (await bundles(world.observer)).find((row) => row.id === PLATFORM_ADMIN);
    expect(bundleRow).toEqual({ id: PLATFORM_ADMIN, revision: 2, reduction_floor: 1 });

    const events = await widenings(world.observer);

    expect(events.map((event) => event.correlation_id)).toEqual([LABEL_0077]);
    expect(events[0]?.related_ids).toEqual({
      bundle_id: PLATFORM_ADMIN,
      revision: 2,
      reduction_floor: 1,
    });
    expect(events[0]?.before_after).toEqual({
      grants: { before: [`${REREGISTER}|own|any|P`], after: [`${REREGISTER}|all|any|P`] },
    });
    expect(await grantsHeld(world.observer)).toEqual(GRANTS.map(labelOf).toSorted());
    const [event] = events;
    if (event === undefined) throw new Error('0078 recorded no widening');
    acceptedByTheWriter(event);
  });
});

describe('a database that 0078 finds nothing widened on', () => {
  let current: TestDatabase;
  let observer: Observer;
  let migration: pg.Client;
  const notices: string[] = [];

  beforeAll(async () => {
    current = await createTestDatabase();
    migration = clientFor(current.urlFor(MIGRATION_ROLE));
    migration.on('notice', (notice) => notices.push(notice.message ?? ''));
    await migration.connect();
    observer = await observe(current);
  });
  afterAll(async () => {
    await observer.close();
    await migration.end();
    await current.drop();
  });

  // Break caught: the migration refusing an empty database (it runs before the seed on every new database), writing for a bundle that is not
  // there, or a database left with an event the first time it is created.
  it('is left as it was when there is no bundle yet, whether 0078 ran at creation or runs again', async () => {
    expect(await observer.count('role_bundle')).toBe(0);
    expect(await observer.count('audit_event')).toBe(0);

    await applyMigration(migration, RECORD_MIGRATION);

    expect(await observer.count('role_bundle')).toBe(0);
    expect(await observer.count('audit_event')).toBe(0);
    expect(notices.filter((notice) => notice.includes('0078'))).toEqual([]);
  });

  // Break caught (truthfulness): a record of a widening for a bundle that was seeded with the final grants and never changed (revision 1),
  // which is every database seeded after the decisions, the owner's re-created one included.
  it('writes nothing for a bundle seeded after the decisions, at revision 1', async () => {
    await seedReferenceData(current);
    const before = await bundles(observer);
    expect(before.find((row) => row.id === PLATFORM_ADMIN)).toEqual({
      id: PLATFORM_ADMIN,
      revision: 1,
      reduction_floor: 1,
    });

    await applyMigration(migration, RECORD_MIGRATION);

    expect(await widenings(observer)).toEqual([]);
    expect(await observer.count('audit_event')).toBe(0);
    expect(await bundles(observer)).toEqual(before);
    expect(await grantsHeld(observer)).toEqual(GRANTS.map(labelOf).toSorted());
    expect(notices.filter((notice) => notice.includes('0078'))).toEqual([]);
    expect(before.map((row) => row.id)).toEqual(bundleIds.toSorted());
  });
});

describe('a history that the arithmetic of 0078 does not describe', () => {
  let world: Upgraded;

  beforeAll(async () => {
    world = await upgraded(seedEarlierContent, STEPS);
  });
  afterAll(async () => {
    await world.close();
  });

  // Break caught: a record written for a widening that cannot be shown. A grant of 0075 that the bundle no longer holds at all hubs says the
  // bundle was changed by something else since, so 0078 records what it can still show (0077) and says what it did not.
  it('records only the widening it can show, and warns about the one it cannot: a grant 0075 widened is not held at all hubs', async () => {
    await world.built.admin.query(
      `update role_bundle_grant set hub_scope = 'own' where bundle_id = $1 and permission_key = 'dispatch.read'`,
      [PLATFORM_ADMIN],
    );

    await applyMigration(world.migration, RECORD_MIGRATION);

    expect((await widenings(world.observer)).map((event) => event.correlation_id)).toEqual([
      LABEL_0077,
    ]);
    expect(
      world.notices.filter((notice) => notice.includes('0075_platform_admin_every_hub')),
    ).toEqual([
      'migration 0078: the Platform Admin bundle does not hold every grant that 0075_platform_admin_every_hub widened at all hubs: that widening is not recorded',
    ]);
  });

  // Break caught: a record written for a bundle that has been reduced since (its floor and revision say it has had a change that is not one
  // of the four steps), so that the arithmetic of the revisions would name a step that did not happen. It warns and writes nothing more.
  it('warns and writes nothing for a bundle that has been reduced since: its floor is not 1', async () => {
    await world.built.admin.query(
      `update role_bundle_grant set hub_scope = 'all' where bundle_id = $1 and permission_key = 'dispatch.read'`,
      [PLATFORM_ADMIN],
    );
    const grants = await world.observer.rows<{
      permission_key: string;
      hub_scope: string;
      ownership_scope: string;
      tier: string | null;
    }>(
      `select permission_key, hub_scope, ownership_scope, tier from role_bundle_grant where bundle_id = $1 and permission_key <> 'vendor.read' order by permission_key`,
      [PLATFORM_ADMIN],
    );
    // The primitive of the time, asked to remove a grant: a reduction (revision 6, floor 6).
    await world.migration.query(
      `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'release-test#reduction')`,
      [PLATFORM_ADMIN, JSON.stringify(grants)],
    );
    const eventsBefore = await widenings(world.observer);
    world.notices.length = 0;

    await applyMigration(world.migration, RECORD_MIGRATION);

    expect(await widenings(world.observer)).toEqual(eventsBefore);
    expect(world.notices.filter((notice) => notice.includes('0078'))).toEqual([
      'migration 0078: the Platform Admin bundle is at revision 6 and floor 6, which the four release steps that changed it cannot leave: the widening of 0075 and 0077 is not recorded',
    ]);
    expect((await bundles(world.observer)).find((row) => row.id === PLATFORM_ADMIN)).toEqual({
      id: PLATFORM_ADMIN,
      revision: 6,
      reduction_floor: 6,
    });
  });
});
