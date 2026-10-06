import type { SecurityContext } from '../../../src/platform/database/transaction-context.js';
import { MIGRATION_ROLE } from '../../../src/tools/database/safety.js';
import { withClient, type TestDatabase } from './test-database.js';

/**
 * A table that exists only in the database tests. B0.4 ships no domain table, so the row-level-security
 * and context behaviour is proven on one that follows the rules a real one must: owned by melarc_owner,
 * row-level security enabled and forced, one policy that decides on the transaction's context and never on
 * the connecting role, and only the grants the runtime role needs. The policy has the shape of the
 * reference policy in SECURITY_DESIGN.md section 14.4: a CASE on the principal type, the same expression
 * for reading and for writing, and a closed ELSE.
 */
export const FIXTURE_SQL = `
CREATE SCHEMA rls_fixture AUTHORIZATION melarc_owner;
GRANT USAGE ON SCHEMA rls_fixture TO melarc_api_runtime;

CREATE TABLE rls_fixture.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_id uuid NOT NULL,
  vendor_organization_id uuid,
  rider_id uuid,
  body text NOT NULL
);
ALTER TABLE rls_fixture.notes OWNER TO melarc_owner;
ALTER TABLE rls_fixture.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_fixture.notes FORCE ROW LEVEL SECURITY;

CREATE POLICY notes_scope ON rls_fixture.notes
  USING (
    CASE melarc.principal_type()
      WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR hub_id = ANY (melarc.authorized_hub_ids())
      WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id()
      WHEN 'RIDER' THEN rider_id = melarc.current_rider_id()
      ELSE false
    END
  )
  WITH CHECK (
    CASE melarc.principal_type()
      WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR hub_id = ANY (melarc.authorized_hub_ids())
      WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id()
      WHEN 'RIDER' THEN rider_id = melarc.current_rider_id()
      ELSE false
    END
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON rls_fixture.notes TO melarc_api_runtime;
`;

export const HUB_A = '11111111-1111-4111-8111-111111111111';
export const HUB_B = '22222222-2222-4222-8222-222222222222';
export const HUB_C = '33333333-3333-4333-8333-333333333333';
export const VENDOR_1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
export const VENDOR_2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
export const RIDER_1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
export const RIDER_2 = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const PRINCIPAL = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';

/** Four rows: each hub holds one row of each vendor, and each vendor's rows are tied to one rider. */
export const SEEDED_NOTES = [
  { hub: HUB_A, vendor: VENDOR_1, rider: RIDER_1, body: 'hub A, vendor 1' },
  { hub: HUB_A, vendor: VENDOR_2, rider: RIDER_2, body: 'hub A, vendor 2' },
  { hub: HUB_B, vendor: VENDOR_1, rider: RIDER_1, body: 'hub B, vendor 1' },
  { hub: HUB_B, vendor: VENDOR_2, rider: RIDER_2, body: 'hub B, vendor 2' },
] as const;

/** Applies the fixture as the migration identity, exactly as a product migration would be applied. */
export async function applyFixture(database: TestDatabase): Promise<void> {
  await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(FIXTURE_SQL));
}

/** Inserts the rows as the cluster administrator, who bypasses row-level security: seeding is not under test. */
export async function seedNotes(database: TestDatabase): Promise<void> {
  await withClient(database.urlFor('postgres'), async (client) => {
    for (const note of SEEDED_NOTES) {
      await client.query(
        'insert into rls_fixture.notes (hub_id, vendor_organization_id, rider_id, body) values ($1, $2, $3, $4)',
        [note.hub, note.vendor, note.rider, note.body],
      );
    }
  });
}

const base = { principalId: PRINCIPAL, correlationId: 'database-test' } as const;

export function staffContext(
  hubIds: readonly string[],
  hubScopeMode: 'SET' | 'ALL' = 'SET',
): SecurityContext {
  return {
    ...base,
    principalType: 'STAFF',
    surface: 'OPS_PORTAL',
    hubScopeMode,
    authorizedHubIds: hubIds,
  };
}

export function vendorContext(vendorOrganizationId: string): SecurityContext {
  return { ...base, principalType: 'VENDOR', surface: 'VENDOR_PWA', vendorOrganizationId };
}

export function riderContext(riderId: string): SecurityContext {
  return { ...base, principalType: 'RIDER', surface: 'RIDER_ANDROID', riderId };
}
