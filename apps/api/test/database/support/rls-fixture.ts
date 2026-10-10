import type { TaskCapability } from '../../../src/platform/database/task-capabilities.js';
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

-- allow-delete: the pooled-context tests prove that row-level security governs DELETE as well as reads and writes
GRANT SELECT, INSERT, UPDATE, DELETE ON rls_fixture.notes TO melarc_api_runtime;
`;

/**
 * The tables the SecurityContext v2 tests need, applied after `FIXTURE_SQL`. They are fixtures like it: owned by
 * melarc_owner, forced row-level security, policies that decide on the context and never on the connecting role.
 *
 *  - `hub_records` is the hub template of SECURITY_DESIGN.md §14.4b: one policy for every command with the ordinary
 *    predicates (the old row in USING, the new row in WITH CHECK), and a second policy FOR SELECT that carries the scope
 *    probe and nothing else. PostgreSQL ORs permissive policies per command, so the probe widens a read of one record and
 *    no other command: UPDATE, DELETE, a locking read and an upsert are judged by the ordinary policy alone. The probe
 *    predicate is never in a FOR ALL policy, whose USING would also decide which rows an UPDATE or a DELETE may touch.
 *  - `owned_records` is the shape of an idempotency record: the row belongs to one principal.
 *  - `system_records` is reached by a SYSTEM context under the `authentication` capability and by nothing else.
 *  - `seeded_records` is a table only a seed writes: its policy admits the `seed` capability, and the runtime role
 *    holds no write grant on it, so asserting the label reaches nothing (GBT-E6).
 */
export const CONTEXT_FIXTURE_SQL = `
CREATE TABLE rls_fixture.hub_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  responsible_hub_id uuid NOT NULL,
  vendor_organization_id uuid,
  body text NOT NULL
);
ALTER TABLE rls_fixture.hub_records OWNER TO melarc_owner;
ALTER TABLE rls_fixture.hub_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_fixture.hub_records FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_records_scope ON rls_fixture.hub_records
  USING (
    CASE melarc.principal_type()
      WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL'
        OR responsible_hub_id = ANY (melarc.authorized_hub_ids())
      WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id()
      ELSE false
    END
  )
  WITH CHECK (
    CASE melarc.principal_type()
      WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL'
        OR responsible_hub_id = ANY (melarc.authorized_hub_ids())
      WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id()
      ELSE false
    END
  );
CREATE POLICY hub_records_probe ON rls_fixture.hub_records FOR SELECT
  USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
-- allow-delete: the tests prove that the probe cannot authorize a DELETE, which needs the grant to be exercised
GRANT SELECT, INSERT, UPDATE, DELETE ON rls_fixture.hub_records TO melarc_api_runtime;

CREATE TABLE rls_fixture.owned_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type text NOT NULL,
  principal_id uuid NOT NULL,
  body text NOT NULL
);
ALTER TABLE rls_fixture.owned_records OWNER TO melarc_owner;
ALTER TABLE rls_fixture.owned_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_fixture.owned_records FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_records_scope ON rls_fixture.owned_records
  USING (principal_id = melarc.current_principal_id() AND principal_type = melarc.principal_type())
  WITH CHECK (principal_id = melarc.current_principal_id() AND principal_type = melarc.principal_type());
GRANT SELECT, INSERT, UPDATE ON rls_fixture.owned_records TO melarc_api_runtime;

CREATE TABLE rls_fixture.system_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL
);
ALTER TABLE rls_fixture.system_records OWNER TO melarc_owner;
ALTER TABLE rls_fixture.system_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_fixture.system_records FORCE ROW LEVEL SECURITY;
CREATE POLICY system_records_scope ON rls_fixture.system_records
  USING (
    CASE melarc.principal_type()
      WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      ELSE false
    END
  )
  WITH CHECK (
    CASE melarc.principal_type()
      WHEN 'SYSTEM' THEN melarc.task_capability() = 'authentication'
      ELSE false
    END
  );
GRANT SELECT, INSERT, UPDATE ON rls_fixture.system_records TO melarc_api_runtime;

CREATE TABLE rls_fixture.seeded_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL
);
ALTER TABLE rls_fixture.seeded_records OWNER TO melarc_owner;
ALTER TABLE rls_fixture.seeded_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_fixture.seeded_records FORCE ROW LEVEL SECURITY;
CREATE POLICY seeded_records_scope ON rls_fixture.seeded_records
  USING (
    CASE melarc.principal_type()
      WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
      ELSE false
    END
  )
  WITH CHECK (
    CASE melarc.principal_type()
      WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed'
      ELSE false
    END
  );
GRANT SELECT ON rls_fixture.seeded_records TO melarc_api_runtime;
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

/** A SYSTEM context working under one capability. */
export function systemContext(taskCapability: TaskCapability): SecurityContext {
  return { ...base, principalType: 'SYSTEM', surface: 'SYSTEM', taskCapability };
}

/** The principal every context above carries, and a second one, for the rows `owned_records` holds. */
export const PRINCIPAL_1 = PRINCIPAL;
export const PRINCIPAL_2 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';

/** Two rows of `hub_records`, one in each hub, with known ids so that the scope probe can name them. */
export const RECORD_IN_HUB_A = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1a1';
export const RECORD_IN_HUB_B = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1b1';
/** A well-formed identifier that no row has. */
export const NO_SUCH_RECORD = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1ff';

/** Applies `CONTEXT_FIXTURE_SQL` as the migration identity. `applyFixture` must have run first. */
export async function applyContextFixture(database: TestDatabase): Promise<void> {
  await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(CONTEXT_FIXTURE_SQL));
}

/** Inserts the rows of the context fixture as the cluster administrator: seeding is not under test. */
export async function seedContextRecords(database: TestDatabase): Promise<void> {
  await withClient(database.urlFor('postgres'), async (client) => {
    await client.query(
      `insert into rls_fixture.hub_records (id, responsible_hub_id, vendor_organization_id, body)
       values ($1, $2, $3, 'record in hub A'), ($4, $5, $6, 'record in hub B')`,
      [RECORD_IN_HUB_A, HUB_A, VENDOR_1, RECORD_IN_HUB_B, HUB_B, VENDOR_2],
    );
    await client.query(
      `insert into rls_fixture.owned_records (principal_type, principal_id, body)
       values ('STAFF', $1, 'owned by principal 1'), ('STAFF', $2, 'owned by principal 2')`,
      [PRINCIPAL_1, PRINCIPAL_2],
    );
    await client.query(
      "insert into rls_fixture.system_records (body) values ('system record one'), ('system record two')",
    );
    await client.query("insert into rls_fixture.seeded_records (body) values ('seeded row')");
  });
}
