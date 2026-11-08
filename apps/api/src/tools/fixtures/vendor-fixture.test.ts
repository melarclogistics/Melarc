import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_IDENTIFIER_ALPHABET,
  ACCOUNT_IDENTIFIER_LENGTH,
  canonicalAccountIdentifier,
} from '../../platform/auth/vendor/vendor-vocabulary.js';
import { HUBS } from '../seed/hubs.js';
import { newAccountIdentifier, vendorFixturePlan } from './vendor-fixture.js';

/**
 * The demonstration vendor (S0.47; MIGRATION_AND_SEEDING.md section 4b): one vendor where an approval leaves it, less the setup grant. What
 * the database function accepts is pinned by `seed.db.test.ts`; this pins what the command asks it for.
 */
describe('vendorFixturePlan', () => {
  const plan = vendorFixturePlan();
  const organization = plan.payload.vendor_organization?.[0] ?? {};
  const account = plan.payload.vendor_account?.[0] ?? {};
  const credential = plan.payload.vendor_credential?.[0] ?? {};

  it('is applied by the vendor fixture function and by nothing else', () => {
    expect(plan.entryPoint).toBe('add_vendor_fixture');
    expect(plan.policyKeys).toEqual({ bundleIds: [], fixedPolicies: [] });
    expect(Object.keys(plan.payload).toSorted()).toEqual([
      'vendor_account',
      'vendor_credential',
      'vendor_organization',
    ]);
  });

  // Stop condition of S0.47: the responsible hub of the fixture organisation is the seeded hub, so its Senior Ops re-issues the grant.
  it('makes the organisation the seeded hub’s, and the account and the credential its own', () => {
    expect(organization.responsible_hub_id).toBe(HUBS[0]?.id);
    expect(account.vendor_organization_id).toBe(organization.id);
    expect(credential.vendor_account_id).toBe(account.id);
  });

  // Break caught: a fixture that hands authentication readiness over (section 4b's second constraint) or that messages a real person.
  it('carries no secret and no phone, and a recovery address no real person holds', () => {
    expect(Object.keys(credential).toSorted()).toEqual(['recovery_email', 'vendor_account_id']);
    expect(credential.recovery_email).toMatch(/@melarc\.invalid$/);
    expect(organization.contact_email).toMatch(/@melarc\.invalid$/);
    expect(String(organization.legal_name)).toMatch(/fixture/i);
  });

  it('gives each run an identifier of the account alphabet and new ids', () => {
    const other = vendorFixturePlan();
    expect(canonicalAccountIdentifier(String(account.account_identifier))).toBe(
      account.account_identifier,
    );
    expect(other.payload.vendor_account?.[0]?.id).not.toBe(account.id);
    expect(other.payload.vendor_organization?.[0]?.id).not.toBe(organization.id);
  });
});

describe('newAccountIdentifier', () => {
  // Break caught: a modulo of random bytes, which makes the first symbols of the alphabet likelier (256 is not a multiple of 31).
  it('draws each character uniformly from the alphabet, by index', () => {
    const asked: number[] = [];
    const identifier = newAccountIdentifier((bound) => {
      asked.push(bound);
      return asked.length - 1;
    });
    expect(asked).toEqual(
      Array.from({ length: ACCOUNT_IDENTIFIER_LENGTH }, () => ACCOUNT_IDENTIFIER_ALPHABET.length),
    );
    expect(identifier).toBe(ACCOUNT_IDENTIFIER_ALPHABET.slice(0, ACCOUNT_IDENTIFIER_LENGTH));
  });

  it('is always an identifier', () => {
    for (let draw = 0; draw < 200; draw += 1) {
      const identifier = newAccountIdentifier();
      expect(canonicalAccountIdentifier(identifier)).toBe(identifier);
    }
  });
});
