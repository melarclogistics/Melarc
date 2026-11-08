import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type pg from 'pg';

import { runSeed, type SeedPlan } from '../../../src/platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../../src/platform/database/technical-roles.js';
import { SLICE_000_GRANTS } from '../../../src/tools/seed/bundles.js';
import { IDENTITY_REASONS, reasonCodeRow } from '../../../src/tools/seed/reasons.js';
import { referenceSeedPlan } from '../../../src/tools/seed/reference-seed.js';
import { buildService } from './service.js';
import type { TestDatabase } from './test-database.js';

/**
 * A database as it was seeded before SLICE-001 (27 October 2026, the owner's), and a migration applied to it the way the migrator
 * applies it (S1.8; migrations 0043 and 0044). Test support: a test of what a later migration does to a database that is already seeded starts here.
 */

/** The permission SLICE-001 added to the catalogue: absent from a database seeded before it. */
export const SLICE_001_PERMISSION = 'pickup.handshake.resolve';

const MIGRATIONS = resolve(import.meta.dirname, '../../../migrations');

/**
 * The seed plan of a database as it was seeded on 27 October 2026: the SLICE-000 grants, no `pickup.handshake.resolve`, the twelve
 * identity reasons only (the workflow reasons came with SLICE-001) and the fixed policy at revision 1.
 */
export function earlierSeedPlan(): SeedPlan {
  const plan = referenceSeedPlan();
  return {
    ...plan,
    payload: {
      ...plan.payload,
      permission: (plan.payload.permission ?? []).filter((row) => row.key !== SLICE_001_PERMISSION),
      reason_code: IDENTITY_REASONS.map((reason) => reasonCodeRow(reason)),
      // The old seed named no revision: a fixed policy started at 1, whatever the build declared (migration 0046 changed that).
      fixed_permission_policy: (plan.payload.fixed_permission_policy ?? []).map((row) => ({
        principal_type: row.principal_type,
      })),
      role_bundle_grant: SLICE_000_GRANTS.map((grant) => ({
        bundle_id: grant.bundleId,
        permission_key: grant.permissionKey,
        hub_scope: grant.hubScope,
        ownership_scope: grant.ownershipScope,
        tier: grant.tier,
      })),
    },
  };
}

/** Seeds a freshly migrated database with the earlier content, as the provisioning login, in one transaction. */
export async function seedEarlierContent(database: TestDatabase): Promise<void> {
  const { service, close } = buildService(database, { login: PROVISIONING_ROLE });
  try {
    await runSeed(service, earlierSeedPlan());
  } finally {
    await close();
  }
}

/**
 * Applies one migration file as the migration login, the way the migrator applies it: the file's statements, in order, in one
 * transaction at the server's default isolation (read committed). `client` is a connection of the migration login.
 */
export async function applyMigration(client: pg.Client, fileName: string): Promise<void> {
  const statements = readFileSync(resolve(MIGRATIONS, fileName), 'utf8')
    .replaceAll('\r\n', '\n')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  await client.query('BEGIN');
  try {
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
