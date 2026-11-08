import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../../src/staff/reserved-system-actor.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
} from './support/credentials.js';
import { insertSessionRow, insertStaff, sessionRow, staffRow } from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import { insertVendor, vendorRow } from './support/vendors.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  withClient,
  type Login,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.30, the second line of the bootstrap (`GBT-E8`; migration 0019; data-scope-registry.md §5.2, `bootstrap`): the policies that the
 * functions' own statements meet, tried **directly** as the table owner (a member of which the migration login is, subject to forced
 * row-level security), so that what is shown is that the policy refuses a row that is not of the bootstrap shape even when the
 * statement is run by a login that has the privilege. The functions themselves, which write the shape and judge the conditions, are
 * `bootstrap-functions.db.test.ts`. Each test runs in a transaction that is rolled back.
 */

const BOOTSTRAP = {
  'melarc.principal_type': 'SYSTEM',
  'melarc.task_capability': 'bootstrap',
} as const;
type Label = Readonly<Record<string, string>>;

let database: TestDatabase;
let admin: pg.Client;
/** An active vendor account with no secret: the principal a vendor row names, so the vendor guard (0035) admits the row. */
let vendorAccountId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  vendorAccountId = (await insertVendor(admin, vendorRow())).accountId;
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

beforeEach(async () => {
  await admin.query(
    'truncate trusted_browser, mfa_challenge, mfa_factor, setup_grant, session, staff_identity',
  );
});

/**
 * Runs `work` as `login` (the migration login becomes the table owner by `SET LOCAL ROLE`), in a transaction with `label` applied the
 * way the database service applies a context, and rolls it back.
 */
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

const asOwner = <T>(label: Label, work: (client: pg.Client) => Promise<T>) =>
  within(MIGRATION_ROLE, label, work, { owner: true });

/** The SQLSTATE of a statement that is refused, or `ran` when it was not. A statement that fails aborts the transaction, so one each. */
async function stateOf(client: pg.Client, text: string, values: unknown[] = []): Promise<string> {
  try {
    await client.query(text, values);
    return 'ran';
  } catch (error) {
    return serverErrorIn(error)?.code ?? 'unknown';
  }
}

const hubId = (): Promise<string> =>
  scalar<string>(admin, 'select id from hub order by id limit 1');

interface Identity {
  readonly id: string;
  readonly status: string;
  readonly bundle: string;
  readonly hub: string | null;
  readonly origin: string;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  /** `FULL` is a credential (hash, moment, generation 1); the two partial forms are rows the table's own check refuses. */
  readonly credential: 'NONE' | 'FULL' | 'MOMENT_ONLY' | 'GENERATION_ONLY';
}

const BOOTSTRAP_SHAPE: Omit<Identity, 'id'> = {
  status: 'ACTIVE',
  bundle: BUNDLE_IDS.platformAdmin,
  hub: null,
  origin: 'BOOTSTRAP',
  createdBy: RESERVED_SYSTEM_ACTOR_ID,
  approvedBy: RESERVED_SYSTEM_ACTOR_ID,
  credential: 'NONE',
};

/** An insert of one identity with exactly the columns given, whatever the shape. */
async function insertIdentity(client: pg.Client, change: Partial<Identity> = {}): Promise<string> {
  const row: Identity = { id: randomUUID(), ...BOOTSTRAP_SHAPE, ...change };
  const email = `policy-${row.id}@melarc.example`;
  return stateOf(
    client,
    `insert into staff_identity (id, work_email, work_email_canonical, full_name, status, role_bundle_id, primary_hub_id,
                                 credential_hash, credential_established_at, credential_generation, created_by, approved_by, origin)
     values ($1, $2, $2, 'Policy Probe', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.id,
      email,
      row.status,
      row.bundle,
      row.hub,
      row.credential === 'FULL' ? '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA' : null,
      row.credential === 'FULL' || row.credential === 'MOMENT_ONLY' ? new Date() : null,
      row.credential === 'FULL' || row.credential === 'GENERATION_ONLY' ? 1 : 0,
      row.createdBy,
      row.approvedBy,
      row.origin,
    ],
  );
}

/** A bootstrap identity and an ordinary one, arranged as the administrator. */
async function arrangeIdentities(): Promise<{ bootstrapId: string; ordinaryId: string }> {
  const bootstrap = await insertStaff(
    admin,
    staffRow({
      origin: 'BOOTSTRAP',
      roleBundleId: BUNDLE_IDS.platformAdmin,
      createdBy: RESERVED_SYSTEM_ACTOR_ID,
      approvedBy: RESERVED_SYSTEM_ACTOR_ID,
      credentialHash: null,
      credentialEstablishedAt: null,
    }),
  );
  const ordinary = await insertStaff(admin, staffRow());
  return { bootstrapId: bootstrap.id, ordinaryId: ordinary.id };
}

describe('StaffIdentity: the bootstrap branch admits the bootstrap shape and nothing else (GBT-E8)', () => {
  it('admits an ACTIVE Platform Admin of origin BOOTSTRAP whose maker and checker are the reserved system actor', async () => {
    expect(await asOwner(BOOTSTRAP, (client) => insertIdentity(client))).toBe('ran');
  });

  // Break caught: a conjunct of the check dropped, or compared with the wrong column, so that an identity that is not the seeded shape
  // is written under the label. Each row below satisfies every constraint of the table and fails exactly one conjunct of the policy.
  const NOT_THE_SHAPE: readonly (readonly [string, () => Promise<Partial<Identity>>])[] = [
    [
      'a MAKER_CHECKER identity',
      () => Promise.resolve({ origin: 'MAKER_CHECKER', approvedBy: randomUUID() }),
    ],
    ['a maker that is not the reserved actor', () => Promise.resolve({ createdBy: randomUUID() })],
    [
      'a checker that is not the reserved actor',
      () => Promise.resolve({ approvedBy: randomUUID() }),
    ],
    ['a bundle that is not Platform Admin', () => Promise.resolve({ bundle: BUNDLE_IDS.opsStaff })],
    ['a status that is not ACTIVE', () => Promise.resolve({ status: 'SUSPENDED' })],
    [
      'a pending profile with no checker',
      () => Promise.resolve({ status: 'PENDING_APPROVAL', approvedBy: null }),
    ],
    ['an identity that has a credential', () => Promise.resolve({ credential: 'FULL' as const })],
    // Row-level security is judged before the table's checks (shown by the probe of S0.30), so each of the three credential columns
    // is refused by the policy on its own, in a row that the table's own check would refuse as well.
    [
      'a moment of establishment with no credential',
      () => Promise.resolve({ credential: 'MOMENT_ONLY' as const }),
    ],
    [
      'a credential generation with no credential',
      () => Promise.resolve({ credential: 'GENERATION_ONLY' as const }),
    ],
    // Origin is judged on its own too: a MAKER_CHECKER row whose maker and checker are both the reserved actor is a row the table
    // refuses (the maker is not the checker), and the policy refuses it first.
    [
      'a MAKER_CHECKER identity whose maker and checker are both the reserved actor',
      () => Promise.resolve({ origin: 'MAKER_CHECKER' }),
    ],
    ['an identity with a primary hub', async () => ({ hub: await hubId() })],
  ];
  it.each(NOT_THE_SHAPE)('refuses %s', async (_name, change) => {
    const refused = await asOwner(BOOTSTRAP, async (client) =>
      insertIdentity(client, await change()),
    );
    expect(refused).toBe('42501');
  });

  // Break caught: the branch admitting the bootstrap shape under any label, or to any person's context.
  it.each([
    ['no context at all', {}],
    [
      'the authentication capability',
      { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'authentication' },
    ],
    [
      'the seed capability',
      { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'seed' },
    ],
    [
      'the bootstrap capability held by a staff member',
      { 'melarc.principal_type': 'STAFF', 'melarc.task_capability': 'bootstrap' },
    ],
    [
      'the bootstrap capability held by a vendor',
      { 'melarc.principal_type': 'VENDOR', 'melarc.task_capability': 'bootstrap' },
    ],
    [
      'the bootstrap capability held by a rider',
      { 'melarc.principal_type': 'RIDER', 'melarc.task_capability': 'bootstrap' },
    ],
  ] as const)('refuses even the bootstrap shape under %s', async (_name, label) => {
    expect(await asOwner(label, (client) => insertIdentity(client))).toBe('42501');
  });

  // Break caught: the label being what stops the provisioning login and the worker, when the privilege is: neither holds an INSERT on
  // the table, so asserting the label reaches nothing. (The API runtime holds one since S0.36 gave it to `createStaffIdentity`, and it is
  // refused by the next test: the bootstrap shape is still the only one this branch admits, and only to the role the bootstrap functions
  // run as, D07.)
  it.each([PROVISIONING_ROLE, WORKER_RUNTIME_ROLE] as const)(
    'refuses %s the insert under the bootstrap label for want of a privilege, not a policy',
    async (login) => {
      const failure = await within(login, BOOTSTRAP, async (client) => {
        try {
          await client.query('insert into staff_identity (id) values ($1)', [randomUUID()]);
        } catch (error) {
          return serverErrorIn(error);
        }
        return undefined;
      });
      expect(failure?.code).toBe('42501');
      // A refusal for want of a privilege, not a policy: PostgreSQL checks the functions a policy calls before the table's privilege, so
      // the message names whichever it reached first.
      expect(failure?.message).toMatch(
        /^permission denied for (table staff_identity|function (reserved_system_actor_id|bootstrap_bundle_id))$/,
      );
      expect(failure?.message).not.toMatch(/row-level security/);
      expect(await within(login, BOOTSTRAP, (client) => insertIdentity(client))).toBe('42501');
    },
  );

  // Break caught: the bootstrap branch admitting a login that is not the role the bootstrap functions run as, now that the API login holds
  // an INSERT on the table (S0.36): asserting the label, it is refused by the policy of the table and not by a missing privilege, whatever
  // it sends.
  it('refuses melarc_api_runtime the insert under the bootstrap label by the policy, since createStaffIdentity gave it the privilege', async () => {
    const failure = await within(API_RUNTIME_ROLE, BOOTSTRAP, async (client) => {
      try {
        await client.query('insert into staff_identity (id) values ($1)', [randomUUID()]);
      } catch (error) {
        return serverErrorIn(error);
      }
      return undefined;
    });
    expect(failure?.code).toBe('42501');
    expect(failure?.message).toMatch(/row-level security/);
    expect(await within(API_RUNTIME_ROLE, BOOTSTRAP, (client) => insertIdentity(client))).toBe(
      '42501',
    );
  });

  it('reads every identity under the capability, so that the emptiness count sees an ordinary profile too, and none without it', async () => {
    await arrangeIdentities();
    const seen = await asOwner(BOOTSTRAP, (client) =>
      scalar<number>(client, 'select count(*)::int from staff_identity'),
    );
    expect(seen).toBe(2);
    expect(
      await asOwner({}, (client) =>
        scalar<number>(client, 'select count(*)::int from staff_identity'),
      ),
    ).toBe(0);
  });

  // Break caught: the lock admitting a change, or admitting an identity that is not a bootstrap identity.
  it('lets the capability lock a bootstrap identity and change nothing of any', async () => {
    const { bootstrapId, ordinaryId } = await arrangeIdentities();
    const locked = await asOwner(BOOTSTRAP, async (client) => ({
      bootstrap: (
        await client.query('select id from staff_identity where id = $1 for no key update', [
          bootstrapId,
        ])
      ).rowCount,
      ordinary: (
        await client.query('select id from staff_identity where id = $1 for no key update', [
          ordinaryId,
        ])
      ).rowCount,
    }));
    expect(locked).toEqual({ bootstrap: 1, ordinary: 0 });

    for (const id of [bootstrapId, ordinaryId]) {
      const state = await asOwner(BOOTSTRAP, (client) =>
        stateOf(client, "update staff_identity set full_name = 'Changed' where id = $1", [id]),
      );
      // The bootstrap row is visible to the update and its check says false: a refusal. The other is not visible: no row, no error.
      expect(state, id === bootstrapId ? 'bootstrap' : 'ordinary').toBe(
        id === bootstrapId ? '42501' : 'ran',
      );
    }
    expect(
      await scalar(admin, "select count(*)::int from staff_identity where full_name = 'Changed'"),
    ).toBe(0);
  });
});

describe('SetupGrant: the bootstrap branch issues two purposes and ends a pending grant, and reads', () => {
  const insertGrantAs = (label: Label, overrides: Parameters<typeof grantRow>[0] = {}) =>
    asOwner(label, async (client) => {
      const principalId = overrides.principalId ?? randomUUID();
      return stateOf(
        client,
        `insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by)
         values ($1, $2, $3, $4, $5, now(), $6, 'PENDING', $7)`,
        [
          randomUUID(),
          overrides.principalType ?? 'STAFF',
          principalId,
          overrides.purpose ?? 'BOOTSTRAP_SETUP',
          grantRow().tokenHash,
          (overrides.purpose ?? 'BOOTSTRAP_SETUP') === 'BOOTSTRAP_SETUP'
            ? null
            : new Date(Date.now() + 1_800_000),
          overrides.issuedBy ?? null,
        ],
      );
    });

  it.each(['BOOTSTRAP_SETUP', 'MFA_REENROLMENT'])(
    'admits a PENDING %s of a staff principal with no issuer',
    async (purpose) => {
      expect(await insertGrantAs(BOOTSTRAP, { purpose })).toBe('ran');
    },
  );

  // Break caught: the branch issuing any purpose, any principal type or on an administrator's behalf: the bootstrap's grants are
  // the two it issues, to a staff identity, with no issuer.
  it.each([
    ['a STAFF_CREDENTIAL_SETUP', { purpose: 'STAFF_CREDENTIAL_SETUP' }],
    ['an MFA_ENROLMENT continuation', { purpose: 'MFA_ENROLMENT' }],
    ['a vendor grant', { principalType: 'VENDOR', purpose: 'VENDOR_CREDENTIAL_SETUP' }],
    // The purpose of a staff grant on a vendor principal: the table's check refuses it, and the policy refuses it first.
    [
      'a staff purpose on a vendor principal',
      { principalType: 'VENDOR', purpose: 'BOOTSTRAP_SETUP' },
    ],
    ['a grant with an issuer', { purpose: 'MFA_REENROLMENT', issuedBy: randomUUID() }],
  ] as const)('refuses %s', async (_name, overrides) => {
    // A vendor row names a real account, so the guard admits it and what refuses it is the policy.
    const principal = 'principalType' in overrides ? { principalId: vendorAccountId } : {};
    expect(await insertGrantAs(BOOTSTRAP, { ...overrides, ...principal })).toBe('42501');
  });

  it.each([
    ['no context', {}],
    [
      'the seed capability',
      { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'seed' },
    ],
    [
      'a staff member holding the bootstrap capability',
      { 'melarc.principal_type': 'STAFF', 'melarc.task_capability': 'bootstrap' },
    ],
  ] as const)('refuses the issue under %s', async (_name, label) => {
    expect(await insertGrantAs(label)).toBe('42501');
  });

  async function pendingGrant(purpose = 'BOOTSTRAP_SETUP'): Promise<string> {
    const { bootstrapId } = await arrangeIdentities();
    return (await insertGrant(admin, grantRow({ principalId: bootstrapId, purpose }))).id;
  }

  // Break caught: the update admitting a consumption (which belongs to the credential operations) or any change to a grant that is
  // not pending; the guard of the table (a pending grant alone changes state) is the layer under this one.
  it('ends a pending grant as SUPERSEDED, and admits no other state', async () => {
    const id = await pendingGrant();
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        stateOf(client, "update setup_grant set state = 'SUPERSEDED' where id = $1", [id]),
      ),
    ).toBe('ran');
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        stateOf(
          client,
          "update setup_grant set state = 'CONSUMED', consumed_at = now() where id = $1",
          [id],
        ),
      ),
    ).toBe('42501');
  });

  it('ends a lapsed grant as EXPIRED, which the table allows only once its expiry has passed', async () => {
    const { bootstrapId } = await arrangeIdentities();
    const lapsed = await insertGrant(
      admin,
      grantRow({
        principalId: bootstrapId,
        purpose: 'MFA_ENROLMENT',
        issuedAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() - 1_800_000),
      }),
    );
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        stateOf(client, "update setup_grant set state = 'EXPIRED' where id = $1", [lapsed.id]),
      ),
    ).toBe('ran');
  });

  it('changes nothing under any other label, and sees nothing without one', async () => {
    const id = await pendingGrant();
    const labels: readonly Label[] = [
      {},
      { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'seed' },
    ];
    for (const label of labels) {
      const result = await asOwner(label, async (client) => ({
        update: (
          await client.query("update setup_grant set state = 'SUPERSEDED' where id = $1", [id])
        ).rowCount,
        visible: await scalar<number>(client, 'select count(*)::int from setup_grant'),
      }));
      expect(result).toEqual({ update: 0, visible: 0 });
    }
    expect(await scalar(admin, 'select state from setup_grant where id = $1', [id])).toBe(
      'PENDING',
    );
  });

  it('reads the grants of every principal under the capability, as the owner-run functions count and look them up', async () => {
    await pendingGrant();
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        scalar<number>(client, 'select count(*)::int from setup_grant'),
      ),
    ).toBe(1);
  });

  // Break caught: a policy that reaches into the staff table, which every login that reads setup_grant would then evaluate: the
  // delivery worker holds three columns of setup_grant and no privilege on staff_identity.
  it('leaves the delivery worker its three columns: no policy of the bootstrap needs a table the worker cannot read', async () => {
    const id = await pendingGrant();
    const rows = await within(
      WORKER_RUNTIME_ROLE,
      { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'credential_delivery' },
      async (client) =>
        (await client.query<{ id: string }>('select id, state, expires_at from setup_grant')).rows,
    );
    expect(rows.map((row) => row.id)).toEqual([id]);
  });
});

describe('MfaFactor: the bootstrap branch revokes a pending factor by the system, and reads', () => {
  async function pendingFactor(): Promise<{ id: string; identity: string }> {
    const { bootstrapId } = await arrangeIdentities();
    const factor = await insertFactor(admin, factorRow(bootstrapId));
    return { id: factor.id, identity: bootstrapId };
  }

  it('revokes a PENDING factor with no administrator, no reason and no episode', async () => {
    const { id } = await pendingFactor();
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        stateOf(
          client,
          "update mfa_factor set status = 'REVOKED', revoked_at = now() where id = $1",
          [id],
        ),
      ),
    ).toBe('ran');
  });

  // Break caught: the update admitting an activation (a proven code is the credential operations'), an administrative revocation, or a
  // revocation of a factor that is already ACTIVE (that is what makes the resume command stop working once it is not needed).
  it.each([
    [
      'an activation',
      "update mfa_factor set status = 'ACTIVE', enrolled_at = now(), last_verified_counter = '1' where id = $1",
    ],
    [
      'a revocation with an administrator',
      "update mfa_factor set status = 'REVOKED', revoked_at = now(), revoked_by = gen_random_uuid() where id = $1",
    ],
    [
      'a revocation with a reason',
      "update mfa_factor set status = 'REVOKED', revoked_at = now(), revocation_reason_code = 'LOST' where id = $1",
    ],
  ])('refuses %s', async (_name, statement) => {
    const { id } = await pendingFactor();
    expect(await asOwner(BOOTSTRAP, (client) => stateOf(client, statement, [id]))).toBe('42501');
  });

  it('reaches no ACTIVE factor: the update sees none, so nothing is revoked and nothing is refused', async () => {
    const { id } = await pendingFactor();
    await activateFactor(admin, id);
    const result = await asOwner(BOOTSTRAP, (client) =>
      client.query("update mfa_factor set status = 'REVOKED', revoked_at = now() where id = $1", [
        id,
      ]),
    );
    expect(result.rowCount).toBe(0);
    expect(await scalar(admin, 'select status from mfa_factor where id = $1', [id])).toBe('ACTIVE');
  });

  it('has no branch to insert a factor, to read none without the capability, or to be used by anything else', async () => {
    const { identity } = await pendingFactor();
    const insert = (label: Label) =>
      asOwner(label, (client) =>
        stateOf(
          client,
          `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version, secret_envelope_version, created_by_purpose)
           values ($1, $2, 'TOTP', 'PENDING', $3, $4, 1, 1, 'MFA_REENROLMENT')`,
          [randomUUID(), identity, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
        ),
      );
    expect(await insert(BOOTSTRAP)).toBe('42501');
    expect(
      await asOwner({}, (client) => scalar<number>(client, 'select count(*)::int from mfa_factor')),
    ).toBe(0);
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        scalar<number>(client, 'select count(*)::int from mfa_factor'),
      ),
    ).toBe(1);
  });
});

describe('AuditEvent: the bootstrap branch writes six events, as SYSTEM, tiered as the catalogue says', () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    event_code: 'staff.identity.created',
    actor_type: 'SYSTEM',
    actor_id: null,
    surface_context: 'SYSTEM',
    object_type: 'StaffIdentity',
    outcome: 'SUCCEEDED',
    enhanced: true,
    ...overrides,
  });

  const insertEvent = (label: Label, row: ReturnType<typeof event>) =>
    asOwner(label, (client) =>
      stateOf(
        client,
        `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id, correlation_id,
                                  outcome, enhanced, serialisation_version)
         values ($1, $2, now(), $3, $4, $5, $6, $7, 'policy-probe', $8, $9, 1)`,
        [
          row.id,
          row.event_code,
          row.actor_type,
          row.actor_id,
          row.surface_context,
          row.object_type,
          randomUUID(),
          row.outcome,
          row.enhanced,
        ],
      ),
    );

  it.each([
    ['staff.identity.created', 'StaffIdentity', true],
    ['staff.identity.approved', 'StaffIdentity', true],
    ['auth.mfa.revoked', 'MfaFactor', true],
    ['auth.setup_grant.issued', 'SetupGrant', false],
    ['auth.setup_grant.superseded', 'SetupGrant', false],
    // The summary of a resume (A07): enhanced, and about the identity that was resumed.
    ['auth.bootstrap.resumed', 'StaffIdentity', true],
  ] as const)('admits %s, enhanced: %s', async (code, objectType, enhanced) => {
    expect(
      await insertEvent(BOOTSTRAP, event({ event_code: code, object_type: objectType, enhanced })),
    ).toBe('ran');
  });

  // Break caught: the branch writing any event of the catalogue (a forged sign-in, a forged recovery) or one at the wrong tier, by a
  // person, from a surface, or as a refusal.
  it.each([
    [
      'an event the bootstrap does not write',
      { event_code: 'auth.session.failed', object_type: 'Session', enhanced: false },
    ],
    ['a creation at the ordinary tier', { enhanced: false }],
    [
      'an issue at the enhanced tier',
      { event_code: 'auth.setup_grant.issued', object_type: 'SetupGrant', enhanced: true },
    ],
    ['an event recorded for a staff member', { actor_type: 'STAFF', actor_id: randomUUID() }],
    ['an event from the Ops Portal', { surface_context: 'OPS_PORTAL' }],
    ['an event of a failed act', { outcome: 'FAILED' }],
    // Break caught: the summary of a resume at the ordinary tier, about something that is not the identity, or with an actor: the
    // reserved actor is a fact of the event, and the table admits no non-null actor for SYSTEM.
    [
      'a summary at the ordinary tier',
      { event_code: 'auth.bootstrap.resumed', object_type: 'StaffIdentity', enhanced: false },
    ],
    [
      'a summary about a grant',
      { event_code: 'auth.bootstrap.resumed', object_type: 'SetupGrant', enhanced: true },
    ],
    [
      'a summary that names an actor',
      { event_code: 'auth.bootstrap.resumed', actor_id: RESERVED_SYSTEM_ACTOR_ID },
    ],
    ['a summary of a failed act', { event_code: 'auth.bootstrap.resumed', outcome: 'REJECTED' }],
  ] as const)('refuses %s', async (_name, overrides) => {
    expect(await insertEvent(BOOTSTRAP, event(overrides))).toBe('42501');
  });

  it.each([
    ['no context', {}],
    [
      'the seed capability',
      { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'seed' },
    ],
    [
      'a staff member holding the bootstrap capability',
      { 'melarc.principal_type': 'STAFF', 'melarc.task_capability': 'bootstrap' },
    ],
  ] as const)('refuses the bootstrap events under %s', async (_name, label) => {
    expect(await insertEvent(label, event())).toBe('42501');
  });

  it('reads nothing of the ledger under the capability: the registry gives SYSTEM insert only', async () => {
    await insertEvent(BOOTSTRAP, event());
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        scalar<number>(client, 'select count(*)::int from audit_event'),
      ),
    ).toBe(0);
  });
});

describe('Session and Setting: the bootstrap branch reads the sessions it must look for and one setting', () => {
  it('reads sessions, none without the capability, and cannot change one', async () => {
    const { bootstrapId } = await arrangeIdentities();
    await insertSessionRow(admin, sessionRow({ principalId: bootstrapId }));
    expect(
      await asOwner(BOOTSTRAP, (client) =>
        scalar<number>(client, 'select count(*)::int from session'),
      ),
    ).toBe(1);
    expect(
      await asOwner({}, (client) => scalar<number>(client, 'select count(*)::int from session')),
    ).toBe(0);
    // No branch updates a session: the statement runs and reaches no row.
    expect(
      await asOwner(
        BOOTSTRAP,
        async (client) =>
          (
            await client.query(
              'update session set last_activity_at = now() where principal_id = $1',
              [bootstrapId],
            )
          ).rowCount,
      ),
    ).toBe(0);
  });

  // Break caught: a read of the whole settings table under the capability, when the resume needs the one lifetime.
  it('reads recovery_link_ttl_minutes and no other setting', async () => {
    const keys = await asOwner(BOOTSTRAP, async (client) =>
      (await client.query<{ key: string }>('select key from setting order by key')).rows.map(
        (row) => row.key,
      ),
    );
    expect(keys).toEqual(['recovery_link_ttl_minutes']);
    expect(
      await asOwner({}, (client) => scalar<number>(client, 'select count(*)::int from setting')),
    ).toBe(0);
  });

  // Break caught: a grant that would give the provisioning login the sessions or the settings the functions read for it. The functions
  // are owner-run: the login reads neither, whatever label it asserts.
  it('gives the provisioning login no read of either under the label', async () => {
    for (const table of ['session', 'setting', 'staff_identity', 'setup_grant', 'mfa_factor']) {
      const state = await within(PROVISIONING_ROLE, BOOTSTRAP, (client) =>
        stateOf(client, `select count(*) from ${table}`),
      );
      expect(state, table).toBe('42501');
    }
  });
});
