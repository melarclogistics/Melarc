import { randomInt, randomUUID } from 'node:crypto';

import {
  ACCOUNT_IDENTIFIER_ALPHABET,
  ACCOUNT_IDENTIFIER_LENGTH,
} from '../../platform/auth/vendor/vendor-vocabulary.js';
import type { SeedPlan } from '../../platform/database/seed/seed-helper.js';
import { HUBS } from '../seed/hubs.js';

/**
 * The demonstration vendor (S0.47; MIGRATION_AND_SEEDING.md section 4b): a non-production fixture, because the operations that create and
 * approve a vendor are SLICE-008's. It leaves **one** vendor where an approval leaves it, less the setup grant: an `ACTIVE` organisation of
 * the seeded hub, made and decided by the reserved system actor, its `ACTIVE` account with a generated identifier, and a credential with a
 * registered email that is its delivery channel and **no secret**. No browser, no grant: `reissueVendorCredentialSetup` issues the grant,
 * and the vendor sets its own secret and registers its own browser. Refused in production by the command, before it connects
 * (`assertFixturesAllowed`); applied by `melarc.add_vendor_fixture` (migration 0034), which writes these three rows and nothing else.
 *
 * - **The addresses are of the reserved `.invalid` domain** (RFC 2606): no real person holds one, and the function refuses any other.
 * - **The allowance is not made.** Section 4b gives the fixture "the allowance in the state creation gives it", but no allowance table
 *   exists in this slice and nothing in it reads one (a finding of the S0.47 handoff).
 */

/** The names and the two addresses of the fixture. Visibly a fixture wherever an operator reads them. */
export const VENDOR_FIXTURE = Object.freeze({
  legalName: 'Melarc Demonstration Vendor (fixture)',
  tradingName: 'Demonstration Vendor',
  contactEmail: 'vendor-contact@melarc.invalid',
  recoveryEmail: 'vendor-recovery@melarc.invalid',
});

/**
 * A new account identifier (SECURITY_DESIGN.md section 13.7a): eight characters, each drawn **uniformly** from the 31 symbols by index (a
 * modulo of random bytes would favour the first ones). `draw(bound)` answers an integer in `[0, bound)`; the default is the system's
 * cryptographic generator. Uniqueness is the table's (`vendor_account_identifier_key`): a collision refuses the insert.
 */
export function newAccountIdentifier(
  draw: (bound: number) => number = (bound) => randomInt(bound),
): string {
  let identifier = '';
  for (let at = 0; at < ACCOUNT_IDENTIFIER_LENGTH; at += 1) {
    identifier += ACCOUNT_IDENTIFIER_ALPHABET.charAt(draw(ACCOUNT_IDENTIFIER_ALPHABET.length));
  }
  return identifier;
}

/** The fixture as a seed plan: new ids and a new identifier each run (a second run is refused by the function while one exists). */
export function vendorFixturePlan(): SeedPlan {
  const organizationId = randomUUID();
  const accountId = randomUUID();
  return {
    policyKeys: { bundleIds: [], fixedPolicies: [] },
    entryPoint: 'add_vendor_fixture',
    payload: {
      vendor_organization: [
        {
          id: organizationId,
          responsible_hub_id: HUBS[0]?.id,
          legal_name: VENDOR_FIXTURE.legalName,
          trading_name: VENDOR_FIXTURE.tradingName,
          contact_email: VENDOR_FIXTURE.contactEmail,
        },
      ],
      vendor_account: [
        {
          id: accountId,
          vendor_organization_id: organizationId,
          account_identifier: newAccountIdentifier(),
        },
      ],
      vendor_credential: [
        { vendor_account_id: accountId, recovery_email: VENDOR_FIXTURE.recoveryEmail },
      ],
    },
    labels: {
      vendor_organization: 'vendor_organization (fixture)',
      vendor_account: 'vendor_account (fixture)',
      vendor_credential: 'vendor_credential (fixture)',
    },
  };
}
