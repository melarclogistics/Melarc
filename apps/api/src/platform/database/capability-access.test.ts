import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_ACCESS,
  IDENTITY_ROLES,
  capabilityPermittedFor,
  type CapabilityAccess,
} from './capability-access.js';
import { TASK_CAPABILITIES } from './task-capabilities.js';

const REGISTRY = resolve(import.meta.dirname, '../../../../../contracts/data-scope-registry.md');

interface RegistryRow {
  readonly capability: string;
  readonly identity: string;
  readonly tables: readonly string[];
}

const SQL_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);

/** The rows of data-scope-registry.md §5.2, read from the document that owns them. */
function registryRows(): RegistryRow[] {
  const text = readFileSync(REGISTRY, 'utf8');
  const start = text.indexOf('### 5.2 ');
  const end = text.indexOf('\n---', start);
  if (start === -1 || end === -1) throw new Error('data-scope-registry.md §5.2 was not found');
  return text
    .slice(start, end)
    .split('\n')
    .filter((line) => /^\| `[a-z_]+`\|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      const [, capability = '', identity = '', , mayTouch = ''] = cells;
      // A table is spelled in capitals and lower case (`StaffIdentity`); `SELECT` and `PENDING` are not tables.
      const tables = [...mayTouch.matchAll(/`([A-Z][a-z][A-Za-z]*)`/g)].map(
        (match) => match[1] ?? '',
      );
      return {
        capability: capability.replaceAll('`', ''),
        // The first name in the cell: the delivery worker's cell goes on to name its roles.
        identity: /`([a-z]+)`/.exec(identity)?.[1] ?? '',
        tables: [...new Set(tables)],
      };
    });
}

const tablesOf = (access: CapabilityAccess) => access.tables.map((entry) => entry.table);

describe('the access matrix per capability, against data-scope-registry.md §5.2', () => {
  const rows = registryRows();

  // Break caught: the registry growing a capability the code does not know (it would be refused as unknown, with no
  // test failing), or the code keeping one the registry dropped.
  it('has a row for exactly the capabilities of the registry', () => {
    expect(rows.map((row) => row.capability).toSorted()).toEqual([...TASK_CAPABILITIES].toSorted());
    expect(Object.keys(CAPABILITY_ACCESS).toSorted()).toEqual([...TASK_CAPABILITIES].toSorted());
  });

  // Break caught: a capability moved to a different technical identity in one place only. The identity holds the
  // grants, so this is what decides who can use the label at all.
  it.each(registryRows())('names the same identity for $capability as the registry', (row) => {
    const access = CAPABILITY_ACCESS[row.capability as keyof typeof CAPABILITY_ACCESS];
    expect(access.identity).toBe(row.identity);
  });

  // Break caught: a table added to or dropped from a capability in code and not in the registry, or the reverse.
  // Statements and restrictions are prose in the registry and are kept in code as written there.
  it.each(registryRows())('lists the same tables for $capability as the registry', (row) => {
    const access = CAPABILITY_ACCESS[row.capability as keyof typeof CAPABILITY_ACCESS];
    expect(tablesOf(access).toSorted()).toEqual(row.tables.toSorted());
  });
});

describe('the invariants the matrix keeps (SECURITY_DESIGN.md §14.1, §14.17b; registry §5.2)', () => {
  const entries = TASK_CAPABILITIES.map(
    (capability) => [capability, CAPABILITY_ACCESS[capability]] as const,
  );

  // Break caught: a capability held by an identity that does not exist in the technical-identity table, which
  // would make "permitted for the identity opening the transaction" unanswerable.
  it.each(entries)('assigns %s to a technical identity with a role', (_capability, access) => {
    expect(Object.keys(IDENTITY_ROLES)).toContain(access.identity);
    expect(IDENTITY_ROLES[access.identity]).toMatch(/^melarc_[a-z_]+$/);
  });

  // Break caught: seed and bootstrap moving to the API identity, which is what makes them a label and not a
  // separation (GBT-E6). They run as the provisioning identity, whose credential is in no API or worker configuration.
  it('keeps seed and bootstrap with the provisioning identity, and the delivery worker with the worker', () => {
    expect(CAPABILITY_ACCESS.seed.identity).toBe('provisioning');
    expect(CAPABILITY_ACCESS.bootstrap.identity).toBe('provisioning');
    expect(CAPABILITY_ACCESS.credential_delivery.identity).toBe('worker');
    expect(CAPABILITY_ACCESS.authentication.identity).toBe('api');
    expect(CAPABILITY_ACCESS.rate_limit.identity).toBe('api');
  });

  // Break caught (S0.27): the policy-change capability handed to a runtime identity, which would let code running as the API, the
  // worker or the provisioning login assert the label with a function it may execute. It belongs to the migration identity alone, and
  // that identity holds nothing else.
  it('keeps policy_change with the migration identity, and gives that identity nothing else', () => {
    expect(CAPABILITY_ACCESS.policy_change.identity).toBe('migration');
    expect(IDENTITY_ROLES.migration).toBe('melarc_migration_elevated');
    const heldByMigration = entries.filter(([, access]) => access.identity === 'migration');
    expect(heldByMigration.map(([capability]) => capability)).toEqual(['policy_change']);
  });

  // Break caught: the policy-change capability reaching a table beyond the three policy tables, or touching them with a statement
  // the functions do not run. The grants of a bundle are replaced as a set (insert, update, delete); the bundle and the fixed policy
  // are read and updated, and never inserted or deleted (the seed inserts, nothing deletes).
  it('lets policy_change touch the three policy tables only, and never insert or delete a bundle or a fixed policy', () => {
    const byTable = new Map(
      CAPABILITY_ACCESS.policy_change.tables.map((entry) => [entry.table, entry.statements]),
    );
    expect([...byTable.keys()].toSorted()).toEqual([
      'FixedPermissionPolicy',
      'RoleBundle',
      'RoleBundleGrant',
    ]);
    expect(byTable.get('RoleBundle')).toEqual(['SELECT', 'UPDATE']);
    expect(byTable.get('FixedPermissionPolicy')).toEqual(['SELECT', 'UPDATE']);
    expect(byTable.get('RoleBundleGrant')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    for (const entry of CAPABILITY_ACCESS.policy_change.tables) {
      expect(entry.restriction, entry.table).toMatch(/only inside melarc\.change_/);
    }
  });

  // Break caught: a capability gaining DELETE. Only the limiter removes rows, and only the expired ones of its own table.
  it('allows DELETE nowhere but on the limiter admission rows and the grants of a bundle being replaced', () => {
    const deleters = entries.flatMap(([capability, access]) =>
      access.tables
        .filter((entry) => entry.statements.includes('DELETE'))
        .map((entry) => `${capability}:${entry.table}`),
    );
    expect(deleters).toEqual(['rate_limit:RateLimitAdmission', 'policy_change:RoleBundleGrant']);
  });

  // Break caught: seed gaining a way to change or to read what it seeded. It inserts into an empty set and refuses otherwise; the
  // count that decides is made inside the database function (migration 0005) and the identity itself reads nothing, so every table
  // of the capability is insert only, and the restriction says by what.
  it('lets seed insert and nothing else, the seven reference tables by the initialization function only', () => {
    for (const entry of CAPABILITY_ACCESS.seed.tables) {
      expect(entry.statements, entry.table).toEqual(['INSERT']);
      if (entry.table !== 'RiderIdentity') {
        expect(entry.restriction, entry.table).toMatch(/melarc\.initialize_reference_data/);
        expect(entry.restriction, entry.table).toMatch(/holds no privilege/);
      }
    }
    expect(CAPABILITY_ACCESS.seed.lookups).toMatch(/^No lookup: the identity holds no privilege/);
  });

  // Break caught: the authentication capability reaching a business table (GBT-E5). Its tables are the identity,
  // credential, session, configuration, delivery, idempotency and audit tables, and no other.
  it('keeps the authentication capability to identity and configuration tables', () => {
    expect(tablesOf(CAPABILITY_ACCESS.authentication).toSorted()).toEqual(
      [
        'AuditEvent',
        'CredentialDeliveryJob',
        'FixedPermissionPolicy',
        'Hub',
        'IdempotencyRecord',
        'MfaChallenge',
        'MfaFactor',
        'Permission',
        'ReasonCode',
        'RecoveryRequest',
        'RegisteredDevice',
        'RiderIdentity',
        'RiderSignInChallenge',
        'RoleBundle',
        'RoleBundleGrant',
        'Session',
        'SetupGrant',
        'Setting',
        'StaffIdentity',
        'VendorAccount',
        'VendorCredential',
      ].toSorted(),
    );
  });

  // Break caught: the audit table being updatable by a capability. It is insert-only for every identity (GBT-J6).
  it('grants INSERT and nothing else on AuditEvent', () => {
    for (const [, access] of entries) {
      for (const entry of access.tables.filter((item) => item.table === 'AuditEvent')) {
        expect(entry.statements).toEqual(['INSERT']);
      }
    }
  });

  // Break caught: a row with no statement, which would list a table and grant it nothing, or a statement not in the
  // closed list of four.
  it('names at least one statement per table, from the four', () => {
    for (const [, access] of entries) {
      for (const entry of access.tables) {
        expect(entry.statements.length).toBeGreaterThan(0);
        for (const statement of entry.statements) expect(SQL_VERBS.has(statement)).toBe(true);
      }
    }
  });

  // Break caught: a capability with no stated place it is opened, which would leave "opened only by" a sentence
  // and not a check. Each place is a directory under src/, ending in a slash.
  it.each(entries)('states where %s is opened, as directories under src', (_capability, access) => {
    expect(access.openedUnder.length).toBeGreaterThan(0);
    for (const directory of access.openedUnder) {
      expect(directory).toMatch(/^(platform|tools)\/[a-z/-]+\/$/);
    }
    for (const text of [access.opener, access.lookups, access.returns]) {
      expect(text.trim()).not.toBe('');
    }
  });
});

describe('capabilityPermittedFor: the identity opening the transaction', () => {
  // Break caught: a role matching by prefix or by case, or a capability permitted to a login that is not its identity.
  it.each([
    ['authentication', 'melarc_api_runtime', true],
    ['rate_limit', 'melarc_api_runtime', true],
    ['seed', 'melarc_provisioning', true],
    ['bootstrap', 'melarc_provisioning', true],
    ['credential_delivery', 'melarc_worker_runtime', true],
    ['policy_change', 'melarc_migration_elevated', true],
    ['policy_change', 'melarc_api_runtime', false],
    ['policy_change', 'melarc_provisioning', false],
    ['policy_change', 'melarc_worker_runtime', false],
    ['policy_change', 'melarc_owner', false],
    ['policy_change', 'postgres', false],
    ['seed', 'melarc_api_runtime', false],
    ['bootstrap', 'melarc_api_runtime', false],
    ['credential_delivery', 'melarc_api_runtime', false],
    ['authentication', 'melarc_provisioning', false],
    ['authentication', 'melarc_worker_runtime', false],
    ['authentication', 'MELARC_API_RUNTIME', false],
    ['authentication', 'melarc_api_runtime_extra', false],
    ['authentication', 'melarc_owner', false],
    ['authentication', 'melarc_migration_elevated', false],
    ['authentication', 'postgres', false],
    ['authentication', '', false],
  ] as const)('%s for %s: %s', (capability, role, permitted) => {
    expect(capabilityPermittedFor(capability, role)).toBe(permitted);
  });

  it('permits nothing to a role that is not known, or to a missing one', () => {
    expect(capabilityPermittedFor('authentication', undefined)).toBe(false);
    expect(capabilityPermittedFor('authentication', null)).toBe(false);
  });
});
