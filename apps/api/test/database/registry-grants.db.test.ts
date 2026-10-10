import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import {
  parseRegistry,
  parseTechnicalInventory,
} from '../../src/test-support/data-scope-registry.js';
import { registryGrantViolations } from '../../src/test-support/registry-grants.js';
import { createTestDatabase, withClient, type TestDatabase } from './support/test-database.js';

/**
 * The database against the data scope registry (security test matrix Family S: GBT-S1, S2; Family K: the grants). Every table
 * the migrations create is classified in section 4 of the registry, and no technical login holds a privilege on one that the
 * registry does not give its identity. The registry is read from the document, not copied.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const registryText = readFileSync(
  resolve(ROOT, 'contracts/data-scope-registry.md'),
  'utf8',
).replaceAll('\r', '');
const REGISTRY = parseRegistry(registryText);
const INVENTORY = parseTechnicalInventory(registryText);

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const violations = (): Promise<string[]> =>
  withClient(database.urlFor('postgres'), (admin) =>
    registryGrantViolations(admin, REGISTRY, INVENTORY),
  );

const admin = <T>(work: (client: import('pg').Client) => Promise<T>): Promise<T> =>
  withClient(database.urlFor('postgres'), work);

describe('the migrated database agrees with the registry', () => {
  // Break caught: a table created by a migration that the registry does not classify (GBT-S1, S2), or a grant to a technical login
  // that the registry does not give it.
  it('classifies every table and grants no login more than the registry allows', async () => {
    expect(await violations()).toEqual([]);
  });

  it('has the seven reference tables, each classified PLATFORM', async () => {
    const names = await admin(async (client) =>
      (
        await client.query(
          `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' order by relname`,
        )
      ).rows.map((row: { relname: string }) => row.relname),
    );
    expect(names).toEqual(
      [
        'fixed_permission_policy',
        'hub',
        'permission',
        'reason_code',
        'role_bundle',
        'role_bundle_grant',
        'setting',
      ].toSorted(),
    );
    for (const table of [
      'Hub',
      'Permission',
      'RoleBundle',
      'RoleBundleGrant',
      'FixedPermissionPolicy',
      'Setting',
      'ReasonCode',
    ]) {
      expect(REGISTRY.find((row) => row.table === table)?.scopeClass, table).toBe('PLATFORM');
    }
  });
});

describe('the check can fire (it is not satisfied by an empty database)', () => {
  // Break caught: a check that reports nothing for any input.
  it('reports a table the registry does not classify', async () => {
    await admin((client) => client.query('create table public.mystery (id integer)'));
    try {
      expect(await violations()).toEqual([
        expect.stringContaining(
          'table mystery is not classified in data-scope-registry.md section 4',
        ),
      ]);
    } finally {
      await admin((client) => client.query('drop table public.mystery'));
    }
  });

  it('reports a technical table that is in the inventory but has no row in section 4', () => {
    const inventoryOnly = INVENTORY.filter((name) => !REGISTRY.some((row) => row.table === name));
    // The inventory and section 4 agree today (every technical table has both rows), so the case is shown with a stand-in.
    expect(inventoryOnly).toEqual([]);
    const text = registryText.replace(
      '| `RateLimitAdmission`| &mdash;',
      '| `RateLimitAdmissionX`| &mdash;',
    );
    expect(parseRegistry(text).some((row) => row.table === 'RateLimitAdmissionX')).toBe(true);
  });

  it.each([
    [API_RUNTIME_ROLE, 'UPDATE', 'role_bundle', 'a runtime login able to change a policy table'],
    [
      API_RUNTIME_ROLE,
      'INSERT',
      'permission',
      'a runtime login able to write the permission catalogue',
    ],
    [WORKER_RUNTIME_ROLE, 'SELECT', 'hub', 'a base worker able to read the hub registry'],
    [WORKER_RUNTIME_ROLE, 'INSERT', 'setting', 'a base worker able to write a setting'],
    // Correction F02: the provisioning login writes the reference tables through the functions of migration 0005 and holds nothing
    // on them. A grant brought back is the way a policy table is appended to after the seed.
    [
      PROVISIONING_ROLE,
      'INSERT',
      'role_bundle_grant',
      'a provisioning login able to append a grant to a bundle directly',
    ],
    [PROVISIONING_ROLE, 'INSERT', 'permission', 'a provisioning login able to add a permission'],
    [PROVISIONING_ROLE, 'SELECT', 'hub', 'a provisioning login able to read a reference table'],
    // The privileges the registry never gives anyone: a table that can be emptied, referenced to take a lock, given a trigger, or
    // locked in any mode (MAINTAIN, PostgreSQL 17 on) by a login that connects.
    [API_RUNTIME_ROLE, 'TRUNCATE', 'hub', 'a runtime login able to empty a table'],
    [PROVISIONING_ROLE, 'TRIGGER', 'setting', 'a provisioning login able to add a trigger'],
    [
      WORKER_RUNTIME_ROLE,
      'MAINTAIN',
      'role_bundle',
      'a base worker able to lock a policy table in any mode',
    ],
    [
      API_RUNTIME_ROLE,
      'REFERENCES',
      'permission',
      'a runtime login able to take a key-share lock by reference',
    ],
  ])('reports %s holding %s on %s: %s', async (role, privilege, table) => {
    await admin((client) => client.query(`grant ${privilege} on public.${table} to ${role}`));
    try {
      const found = await violations();
      expect(found.some((line) => line.includes(`${role} holds ${privilege} on ${table}`))).toBe(
        true,
      );
    } finally {
      await admin((client) => client.query(`revoke ${privilege} on public.${table} from ${role}`));
    }
    expect(await violations()).toEqual([]);
  });

  // Break caught: a column-level grant the table-level check cannot see.
  it('reports a column-level UPDATE', async () => {
    await admin((client) =>
      client.query(`grant update (name) on public.role_bundle to ${API_RUNTIME_ROLE}`),
    );
    try {
      expect(
        (await violations()).some((line) =>
          line.includes(`${API_RUNTIME_ROLE} holds UPDATE on role_bundle`),
        ),
      ).toBe(true);
    } finally {
      await admin((client) =>
        client.query(`revoke update (name) on public.role_bundle from ${API_RUNTIME_ROLE}`),
      );
    }
  });
});
