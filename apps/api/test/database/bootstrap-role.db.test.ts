import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../../src/staff/reserved-system-actor.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { factorRow, grantRow, insertFactor, insertGrant } from './support/credentials.js';
import { insertSessionRow, insertStaff, sessionRow, staffRow } from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import {
  clientFor,
  createTestDatabase,
  withClient,
  type Login,
  type TestDatabase,
} from './support/test-database.js';

/**
 * D07 of the audit of 22 October 2026 (migration 0028): the `bootstrap` capability is a label, and a label is not an identity. The
 * policies of 0019 admit a SYSTEM context under `bootstrap` whoever opened it, so code that already runs as the API's login, and holds
 * the privileges of its own work, could assert the label itself and be admitted where the bootstrap functions are: most of all the
 * insert of an `ACTIVE` Platform Admin that the maker-checker rule would never admit (the day the API's login is given INSERT on
 * `staff_identity` for `createStaffIdentity`). The policies are now bound to the role the bootstrap functions run as, the table
 * owner (a SECURITY DEFINER function runs as its owner), as well as to the capability. Forced row-level security is as it was, and no
 * login is made a member of the owner: what is shown here is the API's login refused where it asserts the label, the legitimate path
 * (`bootstrap-functions.db.test.ts`, `staff-setup-bootstrap.db.test.ts`) unchanged, and the owner's own path admitted.
 */
const BOOTSTRAP = {
  'melarc.principal_type': 'SYSTEM',
  'melarc.task_capability': 'bootstrap',
} as const;
type Label = Readonly<Record<string, string>>;

let database: TestDatabase;
let admin: pg.Client;
let identityId: string;
let factorId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  // One row of each table the bootstrap policies read, so that a read that is refused is seen to be refused and not to have found nothing.
  const identity = await insertStaff(
    admin,
    staffRow({
      roleBundleId: BUNDLE_IDS.platformAdmin,
      origin: 'BOOTSTRAP',
      createdBy: RESERVED_SYSTEM_ACTOR_ID,
      approvedBy: RESERVED_SYSTEM_ACTOR_ID,
      primaryHubId: null,
    }),
  );
  identityId = identity.id;
  await insertGrant(admin, grantRow({ principalId: identity.id, purpose: 'BOOTSTRAP_SETUP' }));
  factorId = (await insertFactor(admin, factorRow(identity.id))).id;
  await insertSessionRow(
    admin,
    sessionRow({
      principalType: 'STAFF',
      principalId: identity.id,
      bundleId: BUNDLE_IDS.platformAdmin,
    }),
  );
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

/** Runs `work` as `login`, in a transaction with `label` applied as the database service applies a context, and rolls it back. */
async function within<T>(
  login: Login,
  label: Label,
  work: (client: pg.Client) => Promise<T>,
  options: { owner?: boolean } = {},
): Promise<T> {
  return withClient(database.urlFor(login), async (client) => {
    await client.query('begin');
    try {
      if (options.owner === true) await client.query('set local role melarc_owner');
      for (const [name, value] of Object.entries(label)) {
        await client.query('select set_config($1, $2, true)', [name, value]);
      }
      return await work(client);
    } finally {
      await client.query('rollback');
    }
  });
}

const asApi = <T>(work: (client: pg.Client) => Promise<T>) =>
  within(API_RUNTIME_ROLE, BOOTSTRAP, work);
const asOwner = <T>(work: (client: pg.Client) => Promise<T>) =>
  within(MIGRATION_ROLE, BOOTSTRAP, work, { owner: true });

interface Outcome {
  readonly state: string;
  readonly message: string;
  readonly rows: number;
}

/** What a statement did: the SQLSTATE and message if the server refused it, and how many rows it touched or returned if not. */
async function outcomeOf(
  client: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<Outcome> {
  try {
    const result = await client.query(text, values);
    return { state: 'ran', message: '', rows: result.rowCount ?? 0 };
  } catch (error) {
    const refusal = serverErrorIn(error);
    return { state: refusal?.code ?? 'unknown', message: refusal?.message ?? '', rows: 0 };
  }
}

const READS = [
  ['staff_identity', 'select id from staff_identity'],
  ['setup_grant', 'select id from setup_grant'],
  ['mfa_factor', 'select id from mfa_factor'],
  ['session', 'select id from session'],
  ['setting', `select key from setting where key = 'recovery_link_ttl_minutes'`],
] as const;

describe('what the API’s login sees when it asserts the bootstrap label', () => {
  // Break caught: a policy that admits the capability whoever opened it, so that the API's login reads, under a label of its own
  // choosing, the rows only the bootstrap functions are meant to read.
  it.each(READS)('shows it no row of %s', async (_table, text) => {
    const seen = await asApi((client) => outcomeOf(client, text));

    expect(seen).toMatchObject({ state: 'ran', rows: 0 });
  });

  // Break caught: the role term cutting off the legitimate role: the owner (which the functions run as) still reads each of them.
  it.each(READS)(
    'still shows the owner, under the same label, the rows of %s',
    async (_table, text) => {
      const seen = await asOwner((client) => outcomeOf(client, text));

      expect(seen.state).toBe('ran');
      expect(seen.rows).toBeGreaterThan(0);
    },
  );
});

describe('what the API’s login may write when it asserts the bootstrap label', () => {
  const RLS = 'row-level security';

  // Break caught: the API's login, which holds INSERT on setup_grant for its own work, issuing a grant of the bootstrap shape under
  // the bootstrap label (a grant the bootstrap commands alone are meant to issue).
  it('is refused a setup grant of the bootstrap shape (42501) and the owner is not', async () => {
    const row = grantRow({ principalId: identityId, purpose: 'MFA_REENROLMENT' });
    const insert = (client: pg.Client) =>
      outcomeOf(
        client,
        `insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by)
         values ($1, 'STAFF', $2, $3, $4, $5, $6, 'PENDING', null)`,
        [row.id, row.principalId, row.purpose, row.tokenHash, row.issuedAt, row.expiresAt],
      );

    const api = await asApi(insert);
    const owner = await asOwner(insert);

    expect(api.state).toBe('42501');
    expect(api.message).toContain(RLS);
    expect(owner.state).toBe('ran');
  });

  // Break caught: the API's login revoking a PENDING factor under the bootstrap label (the one factor update the bootstrap policy
  // admits): the update must find no row.
  it('is refused the revocation of a PENDING factor, and the owner is not', async () => {
    const revoke = (client: pg.Client) =>
      outcomeOf(
        client,
        `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
        [factorId],
      );

    // An update with no WHERE clause reads no column, so the policies for SELECT are not applied to it: the update policy alone decides.
    const revokeAll = (client: pg.Client) =>
      outcomeOf(client, `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp()`);

    const api = await asApi(revoke);
    const owner = await asOwner(revoke);
    const apiAll = await asApi(revokeAll);

    expect(api).toMatchObject({ state: 'ran', rows: 0 });
    expect(owner).toMatchObject({ state: 'ran', rows: 1 });
    expect(apiAll).toMatchObject({ state: 'ran', rows: 0 });
  });

  // Break caught: the API's login writing an event of the bootstrap's own under the bootstrap label, as the SYSTEM actor.
  it('is refused an audit event of the bootstrap, and the owner is not', async () => {
    const write = (client: pg.Client) =>
      outcomeOf(
        client,
        `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                                 correlation_id, outcome, enhanced, serialisation_version)
         values ($1, 'auth.setup_grant.issued', now(), 'SYSTEM', null, 'SYSTEM', 'SetupGrant', $2, 'bootstrap-role-test',
                 'SUCCEEDED', false, 1)`,
        [randomUUID(), randomUUID()],
      );

    const api = await asApi(write);
    const owner = await asOwner(write);

    expect(api.state).toBe('42501');
    expect(api.message).toContain(RLS);
    expect(owner.state).toBe('ran');
  });

  // Break caught (the case that matters): the day the API's login is given INSERT on staff_identity (createStaffIdentity), an ACTIVE
  // Platform Admin made by the bootstrap's own shape, with no maker and no checker, inserted under a label of its own choosing. The
  // privilege is granted here, in this disposable database, to show that the policy and not the missing privilege is what refuses.
  it('is refused an ACTIVE Platform Admin of the bootstrap shape even holding INSERT, and the owner is not', async () => {
    await admin.query('grant insert on staff_identity to melarc_api_runtime');
    try {
      const id = randomUUID();
      const insert = (client: pg.Client) =>
        outcomeOf(
          client,
          `insert into staff_identity (id, work_email, work_email_canonical, full_name, status, role_bundle_id, primary_hub_id,
                                       credential_hash, credential_established_at, credential_generation, created_by, approved_by, origin)
           values ($1, $2, $2, 'Bootstrap Probe', 'ACTIVE', $3, null, null, null, 0, $4, $4, 'BOOTSTRAP')`,
          [id, `role-${id}@melarc.example`, BUNDLE_IDS.platformAdmin, RESERVED_SYSTEM_ACTOR_ID],
        );

      const api = await asApi(insert);
      const owner = await asOwner(insert);

      expect(api.state).toBe('42501');
      expect(api.message).toContain(RLS);
      expect(owner.state).toBe('ran');
    } finally {
      await admin.query('revoke insert on staff_identity from melarc_api_runtime');
    }
  });
});

describe('what is not changed', () => {
  // Break caught: the provisioning login (which holds no privilege on these tables and reaches them only through the functions) given
  // a way in by the role term, or the funcions it calls refused: its direct statements are refused for want of a privilege, as before.
  it('still refuses the provisioning login’s own statements on these tables for want of a privilege', async () => {
    const seen = await within(PROVISIONING_ROLE, BOOTSTRAP, (client) =>
      outcomeOf(client, 'select id from staff_identity'),
    );

    expect(seen.state).toBe('42501');
    expect(seen.message).toContain('permission denied');
  });

  // Break caught: forced row-level security switched off to make the role term pass, or the owner exempted from it.
  it('keeps row-level security forced on every table the bootstrap policies guard', async () => {
    const tables = await admin.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity from pg_class
        where relnamespace = 'public'::regnamespace
          and relname in ('staff_identity', 'setup_grant', 'mfa_factor', 'session', 'setting', 'audit_event')
        order by relname`,
    );

    expect(tables.rows).toHaveLength(6);
    expect(tables.rows.every((row) => row.relforcerowsecurity)).toBe(true);
  });

  // Break caught: a login made a member of the owner or of the migration role to get the policies to pass: the roles are as the
  // technical-identities test fixes them, and the API's login holds neither.
  it('holds the API’s login to no membership of the owner or the migration role', async () => {
    const members = await admin.query<{ member: string; role: string }>(
      `select m.rolname as member, r.rolname as role
         from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
        where m.rolname = $1 and r.rolname in ('melarc_owner', 'melarc_migration_elevated')`,
      [API_RUNTIME_ROLE],
    );

    expect(members.rows).toEqual([]);
  });
});
