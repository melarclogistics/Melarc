import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RegistryError,
  parseRegistry,
  parseTechnicalInventory,
  snakeCaseOf,
} from './data-scope-registry.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const REGISTRY = readFileSync(resolve(ROOT, 'contracts/data-scope-registry.md'), 'utf8').replaceAll(
  '\r',
  '',
);

describe('the data scope registry as the tests read it (GBT-S1, S2)', () => {
  const rows = parseRegistry(REGISTRY);

  // Break caught: a section or a row the reader skips, so a table the document classifies is not there to be checked against.
  it('reads every section, with the table counts the document states', () => {
    const count = (scopeClass: string) =>
      rows.filter((row) => row.scopeClass === scopeClass).length;
    expect({
      PLATFORM: count('PLATFORM'),
      HUB: count('HUB'),
      VENDOR: count('VENDOR'),
      RIDER_ASSIGNMENT: count('RIDER_ASSIGNMENT'),
      AUDIT: count('AUDIT'),
      SYSTEM: count('SYSTEM'),
    }).toEqual({ PLATFORM: 18, HUB: 47, VENDOR: 10, RIDER_ASSIGNMENT: 2, AUDIT: 2, SYSTEM: 4 });
  });

  it('lists a table once', () => {
    const names = rows.map((row) => row.table);
    expect(new Set(names).size).toBe(names.length);
  });

  // Break caught: a column mistaken for another, so an identity is read from the notes, or a row with an unescaped pipe shifts
  // every cell after it.
  it('reads the identities that read and write the reference tables', () => {
    const byName = new Map(rows.map((row) => [row.table, row]));
    expect(byName.get('Hub')).toMatchObject({
      scopeClass: 'PLATFORM',
      readIdentities: ['api'],
      writeIdentities: ['api'],
    });
    expect(byName.get('Setting')?.readIdentities).toEqual(['api', 'worker']);
    expect(byName.get('FixedPermissionPolicy')).toMatchObject({
      scopeClass: 'PLATFORM',
      readIdentities: ['api'],
      writeIdentities: ['seed', 'migration'],
    });
    expect(byName.get('Order')?.writeIdentities).toEqual(['api', 'worker:settlement']);
  });

  it('reads the SYSTEM and Vendor and Rider cells of a reference table as the registry states them', () => {
    const roleBundle = parseRegistry(REGISTRY).find((row) => row.table === 'RoleBundle');
    expect(roleBundle?.cells['Vendor SELECT']).toBe('**DENY**');
    expect(roleBundle?.cells['Rider SELECT']).toBe('**DENY**');
    expect(roleBundle?.cells.SYSTEM).toBe('task cap *(authentication)*');
    expect(roleBundle?.cells['Staff SELECT']).toBe('global');
  });

  it('reads the technical-table inventory of section 6', () => {
    expect(parseTechnicalInventory(REGISTRY)).toEqual([
      'Outbox',
      'IdempotencyRecord',
      'AuditIntegrityCheckpoint',
      'RateLimitAdmission',
      'CredentialDeliveryJob',
    ]);
  });

  // Break caught: a row that has lost or gained a cell being read as if it had not.
  it('refuses a row whose cells do not match its header', () => {
    const broken = REGISTRY.replace('| `Hub`| &mdash; *(is the Hub)*|', '| `Hub`|');
    expect(() => parseRegistry(broken)).toThrow(RegistryError);
  });

  it('refuses a document with no registry', () => {
    expect(() => parseRegistry('# nothing here')).toThrow(RegistryError);
  });
});

describe('snakeCaseOf: the registry names a table in Pascal case and the database in snake case', () => {
  it.each([
    ['Hub', 'hub'],
    ['RoleBundle', 'role_bundle'],
    ['RoleBundleGrant', 'role_bundle_grant'],
    ['FixedPermissionPolicy', 'fixed_permission_policy'],
    ['ReasonCode', 'reason_code'],
    ['MfaFactor', 'mfa_factor'],
    ['RiderSignInChallenge', 'rider_sign_in_challenge'],
  ])('%s is %s', (name, expected) => {
    expect(snakeCaseOf(name)).toBe(expected);
  });
});
