import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUILD_FIXED_POLICY } from '../../src/app.module.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  BUNDLE_IDS,
  GRANTS,
  NOTIFICATION_READ_GRANTS,
  SLICE_000_GRANTS,
  SLICE_001_GRANTS,
  type GrantSeed,
} from '../../src/tools/seed/bundles.js';
import { PERMISSION_KEYS } from '../../src/tools/seed/permission-keys.js';
import {
  applyMigration,
  seedEarlierContent,
  SLICE_001_PERMISSION,
} from './support/earlier-seed.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S1.8, Gate 1: the grants of SLICE-001 reach a database that was seeded before them (migration 0043), and a new database gets the same
 * from the seed (`tools/seed/bundles.ts`), by one rule. The owner's database is the first case: seeded on 27 October 2026 with the
 * SLICE-000 keys, then migrated. The claims, each against a real PostgreSQL:
 *
 * - **Only an addition.** The bundles rise one revision, keep their floor (so no session is ended), lose no grant and change none; the
 *   fixed policy of the Vendor and the Rider rises one revision and keeps its floor.
 * - **Converge.** An earlier seed plus the migration holds exactly the grants a new seed writes: the two cannot drift.
 * - **Nothing to do is nothing done.** An unseeded database is untouched (the seed writes everything there); a seeded one that
 *   already holds the grants is untouched; and the file may run again.
 * - **OB-S1-03.** A session issued before the migration keeps its snapshot and stays live; a sign-in after it carries the new keys.
 *
 * Migration 0057 (S1.12e) adds the one key of the Ops message log, `notification.read`, to the three staff bundles the catalogue gives it
 * to, by the same rule and under the same claims; it is tested after 0043, as the owner's database meets them.
 *
 * Migration 0075 (task P1; the Product Owner's decision of 5 November 2026) widens the Platform Admin's operational grants from their own
 * hub to all hubs, `staff.device.reregister` excepted, as an addition that ends no session (`AC-SLICE-001-84`); it is tested after 0057.
 * The three lists the earlier migrations carry (`SLICE_000_GRANTS`, `SLICE_001_GRANTS`, `NOTIFICATION_READ_GRANTS`) are the content as first
 * written, and `GRANTS` is what a new seed writes with the decision applied.
 *
 * The migration is applied here as the migrator applies it: the file's statements, as the migration login, in one transaction.
 */
const MIGRATION = '0043_slice_001_grants.sql';
const NOTIFICATION_MIGRATION = '0057_notification_read_grant.sql';
const PLATFORM_ADMIN_MIGRATION = '0075_platform_admin_every_hub.sql';

/** The grants as the first two migrations leave them: what the owner's database held before the decision of 5 November 2026. */
const HISTORY: readonly GrantSeed[] = [
  ...SLICE_000_GRANTS,
  ...SLICE_001_GRANTS,
  ...NOTIFICATION_READ_GRANTS,
];

const bundleIds = Object.values(BUNDLE_IDS);
const NEW_PERMISSION = SLICE_001_PERMISSION;
const applyMigrationFile = (client: pg.Client): Promise<void> => applyMigration(client, MIGRATION);
const applyNotificationFile = (client: pg.Client): Promise<void> =>
  applyMigration(client, NOTIFICATION_MIGRATION);
const applyPlatformAdminFile = (client: pg.Client): Promise<void> =>
  applyMigration(client, PLATFORM_ADMIN_MIGRATION);
/** Every migration that carries grants, in the order the migrator runs them. */
const applyBoth = async (client: pg.Client): Promise<void> => {
  await applyMigrationFile(client);
  await applyNotificationFile(client);
  await applyPlatformAdminFile(client);
};

const labelOf = (grant: GrantSeed): string =>
  [
    grant.bundleId,
    grant.permissionKey,
    grant.hubScope,
    grant.ownershipScope,
    grant.tier ?? '-',
  ].join('|');

interface World {
  readonly database: TestDatabase;
  readonly migration: pg.Client;
  readonly observer: Observer;
  close(): Promise<void>;
}

async function world(): Promise<World> {
  const database = await createTestDatabase();
  const migration = clientFor(database.urlFor(MIGRATION_ROLE));
  await migration.connect();
  const observer = await observe(database);
  return {
    database,
    migration,
    observer,
    close: async () => {
      await migration.end();
      await observer.close();
      await database.drop();
    },
  };
}

const bundles = (observer: Observer) =>
  observer.rows<{ id: string; revision: number; reduction_floor: number }>(
    `select id, revision, reduction_floor from role_bundle order by id`,
  );
const policies = (observer: Observer) =>
  observer.rows<{ principal_type: string; revision: number; minimum_revision: number }>(
    `select principal_type, revision, minimum_revision from fixed_permission_policy order by principal_type`,
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
const permissionCount = async (observer: Observer): Promise<number> => observer.count('permission');

describe('a database that has not been seeded', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.close();
  });

  // Break caught: the migration failing on an empty database (NOT_FOUND from the bundle change) and so stopping every new database
  // at its first migrate, or filling the tables before the seed, which would then refuse a table that is not empty.
  it('is left empty by the migration, whether it ran at creation or runs again', async () => {
    expect(await permissionCount(w.observer)).toBe(0);
    expect(await bundles(w.observer)).toEqual([]);
    await applyBoth(w.migration);
    expect(await permissionCount(w.observer)).toBe(0);
    expect(await bundles(w.observer)).toEqual([]);
    expect(await policies(w.observer)).toEqual([]);
    expect(await w.observer.count('role_bundle_grant')).toBe(0);
  });

  // Break caught: a new database seeded at one revision and then migrated into a different one, or the seed refused because the
  // migration had already written part of what it writes.
  // Break caught (the release of SLICE-001 found a gap): a new database seeded at revision 1 while its build declares 2. The next reduction
  // raises the floor from the stored revision, so it would end no session issued under 2, and a reduction would silently not reduce.
  it('is seeded with the whole content, its fixed policy at the revision of the build that seeds it, and a migration after the seed changes nothing', async () => {
    await seedReferenceData(w.database);
    expect(await permissionCount(w.observer)).toBe(PERMISSION_KEYS.length);
    expect(await grantsHeld(w.observer)).toEqual(GRANTS.map(labelOf).toSorted());
    const before = await bundles(w.observer);
    // A bundle starts at revision 1 and floor 1 whatever it holds: its sessions record the revision they were issued from.
    expect(before.map((row) => [row.revision, row.reduction_floor])).toEqual(
      bundleIds.map(() => [1, 1]),
    );

    await applyBoth(w.migration);

    expect(await bundles(w.observer)).toEqual(before);
    expect(await grantsHeld(w.observer)).toEqual(GRANTS.map(labelOf).toSorted());
    expect(await policies(w.observer)).toEqual([
      { principal_type: 'RIDER', revision: BUILD_FIXED_POLICY.RIDER, minimum_revision: 1 },
      { principal_type: 'VENDOR', revision: BUILD_FIXED_POLICY.VENDOR, minimum_revision: 1 },
    ]);
    expect(await permissionCount(w.observer)).toBe(PERMISSION_KEYS.length);
  });
});

describe('a database seeded before SLICE-001 (the owner’s)', () => {
  let w: World;
  let built: BuiltService;
  let machinery: Machinery;
  let admin: pg.Client;
  let held: { readonly sessionId: string; readonly snapshotBefore: unknown };

  beforeAll(async () => {
    w = await world();
    await seedEarlierContent(w.database);
    built = buildService(w.database, { poolMax: 2 });
    machinery = assemble(built);
    admin = clientFor(w.database.urlFor('postgres'));
    await admin.connect();

    // A session of an Ops Staff member, issued by the real protocol before the migration (OB-S1-03).
    const persona = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.opsStaff });
    const row = await w.observer.one<{ id: string; bundle_snapshot: unknown }>(
      `select id, bundle_snapshot from session where principal_id = $1`,
      [persona.identity.id],
    );
    if (row === undefined) throw new Error('the session was not issued');
    held = { sessionId: row.id, snapshotBefore: row.bundle_snapshot };
  });
  afterAll(async () => {
    await built.close();
    await admin.end();
    await w.close();
  });

  it('starts as the owner’s database is: 127 keys, SLICE-000 grants, every bundle at revision 1', async () => {
    expect(await permissionCount(w.observer)).toBe(PERMISSION_KEYS.length - 1);
    expect(await grantsHeld(w.observer)).toEqual(SLICE_000_GRANTS.map(labelOf).toSorted());
    expect((await bundles(w.observer)).map((row) => row.revision)).toEqual(bundleIds.map(() => 1));
  });

  describe('once migration 0043 is applied', () => {
    beforeAll(async () => {
      await applyMigrationFile(w.migration);
    });

    // Break caught: the new key left out of the permission table, so that a grant of it is refused or the key is unknown (denied).
    it('knows the key SLICE-001 added to the catalogue', async () => {
      expect(await permissionCount(w.observer)).toBe(PERMISSION_KEYS.length);
      expect(
        await w.observer.rows(`select key, domain from permission where key = $1`, [
          NEW_PERMISSION,
        ]),
      ).toEqual([{ key: NEW_PERMISSION, domain: 'pickup' }]);
    });

    // Break caught: a grant that differs from the seed's (a scope, a tier, an ownership), which the two ways to a database would
    // then hand to different people; or a grant of SLICE-000 changed or lost.
    it('holds exactly the grants a new seed writes up to it: SLICE-000’s unchanged, SLICE-001’s added', async () => {
      const held = await grantsHeld(w.observer);
      // The key of the Ops message log comes with migration 0057, below.
      expect(held).toEqual([...SLICE_000_GRANTS, ...SLICE_001_GRANTS].map(labelOf).toSorted());
      for (const grant of SLICE_000_GRANTS) expect(held).toContain(labelOf(grant));
      for (const grant of SLICE_001_GRANTS) expect(held).toContain(labelOf(grant));
      for (const grant of NOTIFICATION_READ_GRANTS) expect(held).not.toContain(labelOf(grant));
    });

    // Break caught: an addition declared a reduction (the floor rises and every session of the bundle is ended), or a bundle that
    // gained grants without a new revision (a session cannot tell its snapshot is behind).
    it('raises every bundle by one revision and none of their floors', async () => {
      expect(await bundles(w.observer)).toEqual(
        bundleIds.toSorted().map((id) => ({ id, revision: 2, reduction_floor: 1 })),
      );
    });

    // Break caught: the fixed policy of the Vendor or the Rider not recorded as released, or declared a reduction.
    it('records the release of the fixed Vendor and Rider policy as an addition: the revision of this build, floor 1', async () => {
      // The build that carries the slice's keys declares the revision the database is told of (BUILD_FIXED_POLICY, app.module.ts).
      expect(BUILD_FIXED_POLICY).toEqual({ VENDOR: 2, RIDER: 2 });
      expect(await policies(w.observer)).toEqual([
        { principal_type: 'RIDER', revision: BUILD_FIXED_POLICY.RIDER, minimum_revision: 1 },
        { principal_type: 'VENDOR', revision: BUILD_FIXED_POLICY.VENDOR, minimum_revision: 1 },
      ]);
    });

    // Break caught: the addition ending a session (the authority-revoked event, a terminated row) of someone who lost nothing.
    it('ends no session and writes no revocation', async () => {
      const live = await w.observer.one<{ n: number }>(
        `select count(*)::int as n from session where terminated_at is null`,
      );
      expect(live?.n).toBe(1);
      expect(
        await w.observer.count('audit_event', { event_code: 'auth.session.authority_revoked' }),
      ).toBe(0);
    });

    // OB-S1-03. Break caught: a held session rewritten to carry keys it was not issued with, or ended; and a sign-in that does not
    // read the bundle as it now is.
    it('leaves a session issued before it as issued, and gives a sign-in after it the new keys', async () => {
      const after = await w.observer.one<{
        terminated_at: Date | null;
        bundle_snapshot: unknown;
        bundle_revision: number;
      }>(`select terminated_at, bundle_snapshot, bundle_revision from session where id = $1`, [
        held.sessionId,
      ]);
      expect(after?.terminated_at).toBeNull();
      expect(after?.bundle_revision).toBe(1);
      expect(after?.bundle_snapshot).toEqual(held.snapshotBefore);
      expect(JSON.stringify(after?.bundle_snapshot)).not.toContain('pickup.request.confirm');

      const fresh = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.opsStaff });
      const signedIn = await w.observer.one<{ bundle_revision: number; bundle_snapshot: unknown }>(
        `select bundle_revision, bundle_snapshot from session where principal_id = $1`,
        [fresh.identity.id],
      );
      expect(signedIn?.bundle_revision).toBe(2);
      const snapshot = JSON.stringify(signedIn?.bundle_snapshot);
      for (const key of [
        'pickup.request.confirm',
        'pickup.exception.approve',
        'hub.intake.count',
      ]) {
        expect(snapshot, key).toContain(key);
      }
      // Ops Staff do not hold the keys that start at Senior Ops (the catalogue's S P rows).
      for (const key of ['pickup.handshake.resolve', 'pickup.cancellation_charge.waive']) {
        expect(snapshot, key).not.toContain(key);
      }
    });

    // Break caught: a migration that cannot run twice (a deployment that repeats a step, a restore followed by a migrate), or that
    // raises the revision again for a change it already made.
    it('may run again: the second run changes nothing', async () => {
      const bundlesBefore = await bundles(w.observer);
      const policiesBefore = await policies(w.observer);
      const grantsBefore = await grantsHeld(w.observer);

      await applyMigrationFile(w.migration);

      expect(await bundles(w.observer)).toEqual(bundlesBefore);
      expect(await policies(w.observer)).toEqual(policiesBefore);
      expect(await grantsHeld(w.observer)).toEqual(grantsBefore);
      expect(await permissionCount(w.observer)).toBe(PERMISSION_KEYS.length);
    });
  });

  describe('once migration 0057 is applied (the key of the Ops message log)', () => {
    let liveBefore: string[];
    beforeAll(async () => {
      liveBefore = (
        await w.observer.rows<{ id: string }>(
          `select id from session where terminated_at is null order by id`,
        )
      ).map((row) => row.id);
      await applyNotificationFile(w.migration);
    });

    // Break caught: the key left out of a bundle the catalogue gives it to, given to one it does not (Finance reads no log), or a scope or
    // a tier that differs from the seed's, which the two ways to a database would then hand to different people.
    it('holds exactly the grants a new seed wrote up to it: the key at the own hub of Ops Staff, Senior Ops and Platform Admin, and of no one else', async () => {
      const held = await grantsHeld(w.observer);
      expect(held).toEqual(HISTORY.map(labelOf).toSorted());
      const holders = held.filter((label) => label.split('|')[1] === 'notification.read');
      expect(holders).toEqual(NOTIFICATION_READ_GRANTS.map(labelOf).toSorted());
      expect(holders).toEqual([
        `${BUNDLE_IDS.opsStaff}|notification.read|own|any|A`,
        `${BUNDLE_IDS.seniorOps}|notification.read|own|any|S`,
        `${BUNDLE_IDS.platformAdmin}|notification.read|own|any|P`,
      ]);
    });

    // Break caught: a bundle that gained a grant without a new revision (a session cannot tell its snapshot is behind), a bundle raised
    // that did not change (Finance, the Rider, the Vendor), or a floor that rose (every session of the bundle would be ended).
    it('raises the three bundles that gained the key by one revision, leaves the others as they were, and moves no floor', async () => {
      const gained = new Set<string>([
        BUNDLE_IDS.opsStaff,
        BUNDLE_IDS.seniorOps,
        BUNDLE_IDS.platformAdmin,
      ]);
      expect(await bundles(w.observer)).toEqual(
        bundleIds
          .toSorted()
          .map((id) => ({ id, revision: gained.has(id) ? 3 : 2, reduction_floor: 1 })),
      );
    });

    // Break caught: the fixed Vendor and Rider policy declared released again by a change that did not touch it.
    it('does not touch the fixed Vendor and Rider policy', async () => {
      expect(await policies(w.observer)).toEqual([
        { principal_type: 'RIDER', revision: BUILD_FIXED_POLICY.RIDER, minimum_revision: 1 },
        { principal_type: 'VENDOR', revision: BUILD_FIXED_POLICY.VENDOR, minimum_revision: 1 },
      ]);
    });

    // Break caught: an addition ending a session of someone who lost nothing; and a sign-in after it that does not read the bundle as it
    // now is, or one of a bundle that did not gain the key given it.
    it('ends no session, and gives a sign-in after it the key only where the bundle gained it', async () => {
      expect(liveBefore.length).toBeGreaterThanOrEqual(2);
      expect(
        (
          await w.observer.rows<{ id: string }>(
            `select id from session where terminated_at is null order by id`,
          )
        ).map((row) => row.id),
      ).toEqual(liveBefore);
      expect(
        await w.observer.count('audit_event', { event_code: 'auth.session.authority_revoked' }),
      ).toBe(0);

      const ops = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.opsStaff });
      const opsSession = await w.observer.one<{
        bundle_revision: number;
        bundle_snapshot: unknown;
      }>(`select bundle_revision, bundle_snapshot from session where principal_id = $1`, [
        ops.identity.id,
      ]);
      expect(opsSession?.bundle_revision).toBe(3);
      expect(JSON.stringify(opsSession?.bundle_snapshot)).toContain('notification.read');

      const finance = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.finance });
      const financeSession = await w.observer.one<{
        bundle_revision: number;
        bundle_snapshot: unknown;
      }>(`select bundle_revision, bundle_snapshot from session where principal_id = $1`, [
        finance.identity.id,
      ]);
      expect(financeSession?.bundle_revision).toBe(2);
      expect(JSON.stringify(financeSession?.bundle_snapshot)).not.toContain('notification.read');
    });

    // Break caught: a migration that cannot run twice, or that raises the revision again for a change it already made.
    it('may run again: the second run changes nothing', async () => {
      const bundlesBefore = await bundles(w.observer);
      const grantsBefore = await grantsHeld(w.observer);

      await applyNotificationFile(w.migration);

      expect(await bundles(w.observer)).toEqual(bundlesBefore);
      expect(await grantsHeld(w.observer)).toEqual(grantsBefore);
    });
  });

  describe('once migration 0075 is applied (the Platform Admin at every hub, AC-SLICE-001-84)', () => {
    let liveBefore: string[];
    let adminBefore: { readonly sessionId: string; readonly snapshotBefore: unknown };
    beforeAll(async () => {
      // A session of the Platform Admin, issued by the real protocol before the migration (OB-S1-03): its snapshot holds the grants of its own hub.
      const persona = await staffPersona(machinery, admin, {
        roleBundleId: BUNDLE_IDS.platformAdmin,
      });
      const row = await w.observer.one<{ id: string; bundle_snapshot: unknown }>(
        `select id, bundle_snapshot from session where principal_id = $1`,
        [persona.identity.id],
      );
      if (row === undefined) throw new Error('the session was not issued');
      adminBefore = { sessionId: row.id, snapshotBefore: row.bundle_snapshot };
      liveBefore = (
        await w.observer.rows<{ id: string }>(
          `select id from session where terminated_at is null order by id`,
        )
      ).map((each) => each.id);
      await applyPlatformAdminFile(w.migration);
    });

    // Break caught: a grant widened that the decision does not name, one left at its own hub, a tier or an ownership changed (the
    // maker-checker exception reads the tier), a key added or lost, or another bundle's grant touched; and a database seeded earlier and then
    // migrated that holds other grants than a new seed writes, which the two ways to a database would then hand to different people.
    it('holds exactly the grants a new seed writes: the Platform Admin at all hubs but for the one the decision of 8 October keeps at its own hub, and no one else changed', async () => {
      const held = await grantsHeld(w.observer);
      expect(held).toEqual(GRANTS.map(labelOf).toSorted());
      const platformAdmin = BUNDLE_IDS.platformAdmin;
      const ofAdmin = held.filter((label) => label.startsWith(`${platformAdmin}|`));
      expect(ofAdmin.filter((label) => label.split('|')[2] === 'own')).toEqual([
        `${platformAdmin}|staff.device.reregister|own|any|P`,
      ]);
      expect(ofAdmin.filter((label) => label.split('|')[2] === 'none')).toEqual([
        `${platformAdmin}|permission.assignable_bundle.read|none|any|P`,
      ]);
      for (const label of ofAdmin) {
        expect(label.split('|')[3], label).toBe('any');
        expect(label.split('|')[4], label).toBe('P');
      }
      // The same keys the Platform Admin held before, none added and none lost; every other bundle's grants exactly as they were.
      expect(ofAdmin.map((label) => label.split('|')[1]).toSorted()).toEqual(
        HISTORY.filter((grant) => grant.bundleId === platformAdmin)
          .map((grant) => grant.permissionKey)
          .toSorted(),
      );
      expect(held.filter((label) => !label.startsWith(`${platformAdmin}|`))).toEqual(
        HISTORY.filter((grant) => grant.bundleId !== platformAdmin)
          .map(labelOf)
          .toSorted(),
      );
    });

    // Break caught: a widening declared a reduction (the floor rises and every session of the bundle is ended), a bundle that gained scope
    // without a new revision (a session cannot tell its snapshot is behind), or a bundle raised that did not change.
    it('raises the Platform Admin bundle by one revision, no other bundle, and moves no floor', async () => {
      const gained = new Set<string>([
        BUNDLE_IDS.opsStaff,
        BUNDLE_IDS.seniorOps,
        BUNDLE_IDS.platformAdmin,
      ]);
      expect(await bundles(w.observer)).toEqual(
        bundleIds.toSorted().map((id) => ({
          id,
          revision: id === BUNDLE_IDS.platformAdmin ? 4 : gained.has(id) ? 3 : 2,
          reduction_floor: 1,
        })),
      );
    });

    // Break caught: the fixed Vendor and Rider policy declared released again by a change that did not touch it.
    it('does not touch the fixed Vendor and Rider policy', async () => {
      expect(await policies(w.observer)).toEqual([
        { principal_type: 'RIDER', revision: BUILD_FIXED_POLICY.RIDER, minimum_revision: 1 },
        { principal_type: 'VENDOR', revision: BUILD_FIXED_POLICY.VENDOR, minimum_revision: 1 },
      ]);
    });

    // OB-S1-03. Break caught: a widening that ends a session of someone who lost nothing, a held session rewritten to carry a scope it was not
    // issued with, or a sign-in after it that does not read the bundle as it now is.
    it('ends no session, leaves the session issued before as issued, and gives a sign-in after it the new scope', async () => {
      expect(
        (
          await w.observer.rows<{ id: string }>(
            `select id from session where terminated_at is null order by id`,
          )
        ).map((each) => each.id),
      ).toEqual(liveBefore);
      expect(
        await w.observer.count('audit_event', { event_code: 'auth.session.authority_revoked' }),
      ).toBe(0);

      const after = await w.observer.one<{
        terminated_at: Date | null;
        bundle_snapshot: unknown;
        bundle_revision: number;
      }>(`select terminated_at, bundle_snapshot, bundle_revision from session where id = $1`, [
        adminBefore.sessionId,
      ]);
      expect(after?.terminated_at).toBeNull();
      expect(after?.bundle_revision).toBe(3);
      expect(after?.bundle_snapshot).toEqual(adminBefore.snapshotBefore);

      const fresh = await staffPersona(machinery, admin, {
        roleBundleId: BUNDLE_IDS.platformAdmin,
      });
      const signedIn = await w.observer.one<{ bundle_revision: number; bundle_snapshot: unknown }>(
        `select bundle_revision, bundle_snapshot from session where principal_id = $1`,
        [fresh.identity.id],
      );
      expect(signedIn?.bundle_revision).toBe(4);
      const scopeOf = (snapshot: unknown, key: string): string | undefined =>
        (snapshot as { grants: { permission: string; hubScope: string }[] }).grants.find(
          (grant) => grant.permission === key,
        )?.hubScope;
      expect(scopeOf(adminBefore.snapshotBefore, 'dispatch.read')).toBe('own');
      expect(scopeOf(signedIn?.bundle_snapshot, 'dispatch.read')).toBe('all');
      expect(scopeOf(signedIn?.bundle_snapshot, 'pickup.read')).toBe('all');
      expect(scopeOf(signedIn?.bundle_snapshot, 'staff.device.reregister')).toBe('own');
    });

    // Break caught: a migration that cannot run twice, or that raises the revision again for a change it already made.
    it('may run again: the second run changes nothing', async () => {
      const bundlesBefore = await bundles(w.observer);
      const grantsBefore = await grantsHeld(w.observer);

      await applyPlatformAdminFile(w.migration);

      expect(await bundles(w.observer)).toEqual(bundlesBefore);
      expect(await grantsHeld(w.observer)).toEqual(grantsBefore);
    });
  });
});
