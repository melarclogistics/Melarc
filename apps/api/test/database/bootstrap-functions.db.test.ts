import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Sha256TokenService } from '../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  APPROVED_DEFINER_EXECUTE,
  ROLE_POSTURE_SQL,
  rolePostureParameters,
  unsafeFlags,
} from '../../src/platform/database/role-posture.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../../src/staff/reserved-system-actor.js';
import {
  planResume,
  planSeed,
  type IdentityState,
} from '../../src/tools/bootstrap/bootstrap-plan.js';
import { BOOTSTRAP_BUNDLE_ID } from '../../src/tools/bootstrap/bootstrap-vocabulary.js';
import { catalogViolations } from '../../src/tools/database/catalog-invariants.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
  setGrantState,
} from './support/credentials.js';
import { insertSessionRow, insertStaff, sessionRow, staffRow } from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.30, the database half of the bootstrap seed and the resume command (migration 0019; MIGRATION_AND_SEEDING.md §3.2 and §3.3a).
 * The functions are called as raw SQL, as the provisioning login, with no command in front, so that what these tests show is the
 * database's: it holds no privilege on the staff, grant, factor, session or audit tables, the functions are the only way in, and
 * each refuses unless its rule holds. `bootstrap-policies.db.test.ts` is the second line (the policies the functions' own statements
 * meet, `GBT-E8`), and `bootstrap-command.db.test.ts` is the commands over real folders.
 */

const tokens = new Sha256TokenService();
const clock = { now: () => new Date() };

const SEED = 'select melarc.seed_bootstrap_administrators($1::jsonb) as report';
const STATUS = 'select melarc.bootstrap_status() as status';
const STATE = 'select melarc.bootstrap_identity_state($1) as state';
const RESUME = 'select melarc.resume_bootstrap_identity($1::jsonb) as report';

let database: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
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

const correlation = (): string => `bootstrap-test-${randomUUID()}`;

function newPlan(label = correlation()) {
  const plan = planSeed(
    [
      { fullName: 'Kofi Boateng', workEmail: `kofi-${label}@melarc.example` },
      { fullName: 'Efua Addo', workEmail: `efua-${label}@melarc.example` },
    ],
    { tokens, clock, correlationId: label },
  );
  return { ...plan, label };
}

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('the test expected a value that is not there');
  return value;
};

const asProvisioning = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
  withClient(database.urlFor(PROVISIONING_ROLE), work);

const seed = (document: string) =>
  asProvisioning((client) => client.query<{ report: Record<string, number> }>(SEED, [document]));

interface Failure {
  readonly code: string | undefined;
  readonly message: string;
  readonly detail: string | undefined;
  readonly table: string | undefined;
  readonly constraint: string | undefined;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Failure> {
  try {
    await run();
  } catch (error) {
    const server = serverErrorIn(error);
    if (server === undefined) throw error;
    return {
      code: server.code,
      message: server.message,
      detail: server.detail,
      table: server.table,
      constraint: server.constraint,
    };
  }
  throw new Error('expected the database to refuse');
}

const count = async (table: string): Promise<number> =>
  Number(await scalar(admin, `select count(*)::int from ${table}`));

/** What a seed run leaves, by its correlation id: the three tables the function writes. */
async function leftBy(label: string): Promise<{ staff: number; grants: number; audit: number }> {
  return {
    staff: await count('staff_identity'),
    grants: await count('setup_grant'),
    audit: Number(
      await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
        label,
      ]),
    ),
  };
}

describe('the reserved system actor and the bootstrap bundle in the database', () => {
  // Break caught: the policy and the TypeScript constants naming two different actors or bundles, so that every seeded record is
  // refused or the refusal compares against nothing.
  it('are the values the application writes, callable by the API runtime that evaluates the policy and by no other login', async () => {
    for (const [name, expected] of [
      ['reserved_system_actor_id', RESERVED_SYSTEM_ACTOR_ID],
      ['bootstrap_bundle_id', BOOTSTRAP_BUNDLE_ID],
    ] as const) {
      for (const login of ['postgres', API_RUNTIME_ROLE] as const) {
        const value = await withClient(database.urlFor(login), (client) =>
          scalar(client, `select melarc.${name}()`),
        );
        expect(value, `${name} as ${login}`).toBe(expected);
      }
      for (const login of [PROVISIONING_ROLE, WORKER_RUNTIME_ROLE] as const) {
        const failure = await refusalOf(() =>
          withClient(database.urlFor(login), (client) => client.query(`select melarc.${name}()`)),
        );
        expect(failure.code, `${name} as ${login}`).toBe('42501');
      }
      const row = (
        await admin.query<{ volatility: string; owner: string }>(
          `select p.provolatile as volatility, pg_get_userbyid(p.proowner) as owner
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'melarc' and p.proname = $1`,
          [name],
        )
      ).rows[0];
      expect(row, name).toEqual({ volatility: 'i', owner: 'melarc_owner' });
    }
  });
});

describe('who can reach the bootstrap, and by what', () => {
  const FUNCTIONS = [
    'melarc.bootstrap_status()',
    'melarc.seed_bootstrap_administrators(jsonb)',
    'melarc.bootstrap_identity_state(text)',
    'melarc.resume_bootstrap_identity(jsonb)',
  ] as const;

  // Break caught: a function executable by PUBLIC, the API or the worker, which would let a request reach the seed; or one that is
  // not SECURITY DEFINER with its search_path fixed, which would run with the caller's powers or the caller's path.
  it.each(FUNCTIONS)(
    '%s is a definer function of the owner that only the provisioning login may execute',
    async (name) => {
      const row = (
        await admin.query<{
          definer: boolean;
          owner: string;
          config: string[] | null;
          provisioning: boolean;
          api: boolean;
          worker: boolean;
          public: boolean;
        }>(
          `select p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
                has_function_privilege($2, p.oid, 'EXECUTE') as provisioning,
                has_function_privilege($3, p.oid, 'EXECUTE') as api,
                has_function_privilege($4, p.oid, 'EXECUTE') as worker,
                -- A function with no ACL at all is executable by PUBLIC (the default); after REVOKE ... FROM PUBLIC it has one.
                (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                                              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) as public
           from pg_proc p where p.oid = $1::regprocedure`,
          [name, PROVISIONING_ROLE, API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE],
        )
      ).rows[0];
      expect(row?.definer).toBe(true);
      expect(row?.owner).toBe('melarc_owner');
      expect(row?.config).toContain('search_path=pg_catalog, pg_temp');
      expect(row).toMatchObject({ provisioning: true, api: false, worker: false, public: false });
    },
  );

  // Break caught: the label being what stops the provisioning login, when what stops it is that it holds no privilege to assert
  // the label against (registry §5.2, the three rules).
  it('leaves the provisioning login with no privilege on the tables the functions write', async () => {
    for (const table of ['staff_identity', 'setup_grant', 'mfa_factor', 'audit_event', 'session']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
        const held = await scalar<boolean>(admin, 'select has_table_privilege($1, $2, $3)', [
          PROVISIONING_ROLE,
          table,
          privilege,
        ]);
        expect(held, `${privilege} on ${table}`).toBe(false);
      }
      const column = await scalar<boolean>(
        admin,
        `select has_any_column_privilege($1, $2, 'SELECT, INSERT, UPDATE, REFERENCES')`,
        [PROVISIONING_ROLE, table],
      );
      expect(column, `a column of ${table}`).toBe(false);
    }
  });

  it('lists the four functions as approved for the provisioning login, and for nobody else', () => {
    expect(APPROVED_DEFINER_EXECUTE[PROVISIONING_ROLE]).toEqual(
      expect.arrayContaining([
        'melarc.bootstrap_status',
        'melarc.seed_bootstrap_administrators',
        'melarc.bootstrap_identity_state',
        'melarc.resume_bootstrap_identity',
      ]),
    );
    expect(APPROVED_DEFINER_EXECUTE[API_RUNTIME_ROLE]).toEqual([
      'melarc.staff_credential_hash',
      'melarc.staff_reset_facts',
      'melarc.staff_locked_facts',
      'melarc.session_by_token_hash',
      'melarc.mfa_factor_sealed_seed',
      'melarc.use_trusted_browser',
      'melarc.trusted_browser_id_for',
      // S0.47 (migration 0034): the vendor's secret hash and browser for the authentication capability, a secret's facts for the reads,
      // and the lock and facts of an account for the administrators' acts.
      'melarc.vendor_secret_hash',
      'melarc.vendor_device_by_credential',
      'melarc.vendor_credential_facts',
      'melarc.vendor_locked_facts',
      // S0.53 (migration 0040): the rider's PIN hash and sole `ACTIVE` device for the authentication capability, and the lock and facts of a
      // rider for the administrators' acts.
      'melarc.rider_pin_hash',
      'melarc.rider_active_device',
      'melarc.rider_locked_facts',
      // S1.26 (migration 0068): the two narrow operations of the rider's count.
      'melarc.collection_handshake_type',
      'melarc.promote_collected_sender',
      // S1.27 (migration 0070): the five operations of the collection handshake.
      'melarc.handshake_issue',
      'melarc.handshake_verify',
      'melarc.handshake_sms_fallback',
      'melarc.handshake_override',
      'melarc.handshake_resolve',
      // S1.29 (migration 0071): the vendor's dispute of a collection.
      'melarc.dispute_collection',
      // S1.28 (migration 0073): the one read of a hub's door wait, for the rider's failure key.
      'melarc.rider_door_wait_minutes',
    ]);
  });

  it.each([API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE] as const)(
    'refuses %s the functions: permission denied, not "no rows"',
    async (login) => {
      for (const statement of [STATUS, SEED, STATE, RESUME]) {
        const failure = await refusalOf(() =>
          withClient(database.urlFor(login), (client) =>
            client.query(
              statement,
              statement === STATUS ? [] : [statement === STATE ? 'a@b.example' : '{}'],
            ),
          ),
        );
        expect(failure.code, statement).toBe('42501');
      }
    },
  );

  it('leaves the provisioning login and the API a clean bill under the role posture and the catalogue checks', async () => {
    for (const role of [PROVISIONING_ROLE, API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE]) {
      const posture = (
        await admin.query<Record<string, unknown>>(ROLE_POSTURE_SQL, rolePostureParameters(role))
      ).rows[0];
      expect(unsafeFlags(posture ?? { missing: true }), role).toEqual([]);
    }
    expect(await catalogViolations(admin)).toEqual([]);
  });
});

describe('the status function', () => {
  it('counts the staff table and changes nothing', async () => {
    const empty = await asProvisioning((client) =>
      client.query<{ status: Record<string, number> }>(STATUS),
    );
    expect(empty.rows[0]?.status).toEqual({ staff_identity: 0 });
    await seed(newPlan().document);
    const filled = await asProvisioning((client) =>
      client.query<{ status: Record<string, number> }>(STATUS),
    );
    expect(filled.rows[0]?.status).toEqual({ staff_identity: 2 });
  });

  // Break caught: a status that only reads, so that a second seed's sweep of orphan bundles could run while the first seed is still
  // between writing its bundles and committing its pair, and delete bundles that are about to be valid.
  it('holds the staff table against another seed until its own transaction ends', async () => {
    const first = clientFor(database.urlFor(PROVISIONING_ROLE));
    await first.connect();
    try {
      await first.query('begin');
      await first.query(STATUS);
      let finished = false;
      const second = asProvisioning((client) => client.query(STATUS)).then((result) => {
        finished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished, 'the second status waits for the first transaction').toBe(false);
      await first.query('rollback');
      await second;
      expect(finished).toBe(true);
    } finally {
      await first.end();
    }
  });
});

describe('the seed function: the pair', () => {
  it('creates exactly two ACTIVE Platform Admins of origin BOOTSTRAP, with the reserved system actor as maker and checker', async () => {
    const plan = newPlan();
    const result = await seed(plan.document);
    expect(result.rows[0]?.report).toEqual({ staff_identity: 2, setup_grant: 2, audit_event: 6 });

    const rows = (
      await admin.query<Record<string, unknown>>(
        'select * from staff_identity order by work_email_canonical',
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'ACTIVE',
        origin: 'BOOTSTRAP',
        role_bundle_id: BOOTSTRAP_BUNDLE_ID,
        primary_hub_id: null,
        credential_hash: null,
        credential_established_at: null,
        // bigint: the driver returns it as text
        credential_generation: '0',
        created_by: RESERVED_SYSTEM_ACTOR_ID,
        approved_by: RESERVED_SYSTEM_ACTOR_ID,
      });
    }
    expect(rows.map((row) => row.id).sort()).toEqual(plan.administrators.map((a) => a.id).sort());
    expect(rows.map((row) => row.work_email_canonical)).toEqual(
      plan.administrators.map((a) => a.workEmailCanonical).sort(),
    );
    // BOOTSTRAP_BUNDLE_ID is the Platform Admin bundle of the reference seed, held to it by this test and not by the command.
    expect(BOOTSTRAP_BUNDLE_ID).toBe(BUNDLE_IDS.platformAdmin);
  });

  // Break caught: a second secret for one identity, a secret that expires (a clock there strands an environment nobody can sign
  // into), or one stored in any form but the hash the plan made.
  it('gives each administrator one unconsumed BOOTSTRAP_SETUP grant held only as the hash, with no expiry', async () => {
    const plan = newPlan();
    await seed(plan.document);
    const grants = (
      await admin.query<{
        id: string;
        principal_type: string;
        principal_id: string;
        purpose: string;
        state: string;
        hash: string;
        expires_at: Date | null;
        issued_by: string | null;
        episode_id: string | null;
        consumed_at: Date | null;
      }>(
        `select id, principal_type, principal_id, purpose, state, encode(token_hash, 'hex') as hash, expires_at, issued_by,
                episode_id, consumed_at from setup_grant order by id`,
      )
    ).rows;
    expect(grants).toHaveLength(2);
    for (const administrator of plan.administrators) {
      const grant = grants.find((row) => row.id === administrator.grantId);
      expect(grant).toMatchObject({
        principal_type: 'STAFF',
        principal_id: administrator.id,
        purpose: 'BOOTSTRAP_SETUP',
        state: 'PENDING',
        expires_at: null,
        issued_by: null,
        episode_id: null,
        consumed_at: null,
      });
      expect(grant?.hash).toBe(
        Buffer.from(tokens.hash(administrator.secret) ?? []).toString('hex'),
      );
    }
    expect(await count('mfa_factor')).toBe(0);
  });

  // Break caught: a pair written in more than one transaction (a failure between two inserts leaves one identity), or an event
  // written apart from the identity it records.
  it('writes the identities, the grants and their six events in one transaction', async () => {
    const plan = newPlan();
    await seed(plan.document);
    const transactions = Number(
      await scalar(
        admin,
        `select count(distinct x)::int from (
           select xmin::text as x from staff_identity
           union all select xmin::text from setup_grant
           union all select xmin::text from audit_event where correlation_id = $1) as writers`,
        [plan.label],
      ),
    );
    expect(transactions).toBe(1);
  });

  it('writes the enhanced creation and approval and the ordinary issue of each administrator, as SYSTEM, with the diff', async () => {
    const plan = newPlan();
    await seed(plan.document);
    const events = (
      await admin.query<Record<string, unknown>>(
        'select * from audit_event where correlation_id = $1 order by event_code, object_id',
        [plan.label],
      )
    ).rows;
    expect(events).toHaveLength(6);
    expect(events.map((event) => event.event_code)).toEqual([
      'auth.setup_grant.issued',
      'auth.setup_grant.issued',
      'staff.identity.approved',
      'staff.identity.approved',
      'staff.identity.created',
      'staff.identity.created',
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_type: 'SYSTEM',
        actor_id: null,
        surface_context: 'SYSTEM',
        outcome: 'SUCCEEDED',
      });
      expect(event.enhanced).toBe(event.event_code !== 'auth.setup_grant.issued');
      expect(event.recorded_at).toBeInstanceOf(Date);
    }
    const created = events.filter((event) => event.event_code === 'staff.identity.created');
    expect(created.map((event) => event.object_id).sort()).toEqual(
      plan.administrators.map((a) => a.id).sort(),
    );
    for (const event of created) expect(event.before_after).not.toBeNull();
  });

  // Break caught: a secret, an address or a name reaching the ledger or the tables beside the hash.
  it('leaves no secret, no address and no name anywhere but the two columns that hold them', async () => {
    const plan = newPlan();
    await seed(plan.document);
    const everything = JSON.stringify([
      (await admin.query('select * from setup_grant')).rows,
      (await admin.query('select * from audit_event')).rows,
    ]);
    for (const administrator of plan.administrators) {
      expect(everything).not.toContain(administrator.secret);
      expect(everything).not.toContain(administrator.workEmail);
      expect(everything).not.toContain(administrator.fullName);
    }
  });

  // Break caught: the label of the caller being read as proof (the context the function sets is its own), or left set after it.
  it('sets its own context for its own statements and gives the caller back the one it had', async () => {
    const plan = newPlan();
    const seen = await asProvisioning(async (client) => {
      await client.query('begin');
      await client.query(
        "select set_config('melarc.principal_type', 'STAFF', true), set_config('melarc.task_capability', 'authentication', true)",
      );
      await client.query(SEED, [plan.document]);
      const after = await client.query<{ type: string; capability: string }>(
        "select current_setting('melarc.principal_type', true) as type, current_setting('melarc.task_capability', true) as capability",
      );
      await client.query('rollback');
      return after.rows[0];
    });
    expect(seen).toEqual({ type: 'STAFF', capability: 'authentication' });
    expect(await count('staff_identity')).toBe(0);
  });
});

describe('the seed function: once, and only on an empty table', () => {
  // Break caught: a second seed that adds to a table the first filled, which makes the seed a standing way to create administrators.
  it('refuses a second run, names the table and the rows, and changes nothing', async () => {
    const first = newPlan();
    await seed(first.document);
    const before = JSON.stringify([
      (await admin.query('select * from staff_identity order by id')).rows,
      (await admin.query('select id, state from setup_grant order by id')).rows,
    ]);
    const second = newPlan();
    const failure = await refusalOf(() => seed(second.document));
    expect(failure.code).toBe('55000');
    expect(failure.table).toBe('staff_identity');
    expect(failure.detail).toBe('reason=STAFF_TABLE_NOT_EMPTY;rows=2');
    expect(failure.message).not.toContain(second.administrators[0]?.workEmail);
    const after = JSON.stringify([
      (await admin.query('select * from staff_identity order by id')).rows,
      (await admin.query('select id, state from setup_grant order by id')).rows,
    ]);
    expect(after).toBe(before);
    // The ledger is append-only and the tests share it: the refused run wrote no event under its own correlation id, and the first
    // run's six are still there.
    expect(await leftBy(second.label)).toMatchObject({ audit: 0 });
    expect(await leftBy(first.label)).toMatchObject({ audit: 6 });
  });

  // Break caught: an emptiness test that counts only bootstrap identities, so that one ordinary profile does not stop the seed.
  it('refuses a table that holds one ordinary identity and nothing of the bootstrap', async () => {
    await insertStaff(admin, staffRow());
    const failure = await refusalOf(() => seed(newPlan().document));
    expect(failure.code).toBe('55000');
    expect(failure.detail).toBe('reason=STAFF_TABLE_NOT_EMPTY;rows=1');
    expect(await count('setup_grant')).toBe(0);
  });

  // Break caught: the guard in the application only, or a lock that lets two seeds count the table as empty together.
  it('lets one of two simultaneous seeds in and refuses the other', async () => {
    const plans = [newPlan(), newPlan()] as const;
    const outcomes = await Promise.allSettled(plans.map((plan) => seed(plan.document)));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(serverErrorIn(must(refused[0]).reason)?.code).toBe('55000');
    expect(await count('staff_identity')).toBe(2);
    expect(await count('setup_grant')).toBe(2);
    const written = await Promise.all(plans.map((plan) => leftBy(plan.label)));
    expect(written.map((run) => run.audit).sort()).toEqual([0, 6]);
  });

  // Break caught: the reference data missing reaching the operator as a bare foreign-key violation, or the identities written
  // without a bundle to hold.
  it('refuses, writing nothing, when the Platform Admin bundle is not there', async () => {
    const plan = newPlan();
    // The bundle is removed on a private copy of the situation: a transaction that is rolled back around the call, so the shared
    // database keeps its bundle for the tests that follow.
    const failure = await withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      try {
        await client.query('delete from role_bundle_grant where bundle_id = $1', [
          BOOTSTRAP_BUNDLE_ID,
        ]);
        await client.query('delete from role_bundle where id = $1', [BOOTSTRAP_BUNDLE_ID]);
        await client.query('set role melarc_provisioning');
        return await refusalOf(() => client.query(SEED, [plan.document]));
      } finally {
        await client.query('rollback');
      }
    });
    expect(failure.code).toBe('23503');
    expect(failure.constraint).toBe('staff_identity_bundle_fkey');
    expect(await count('staff_identity')).toBe(0);
  });
});

describe('the seed function: what it refuses in the document', () => {
  interface Document {
    administrators: Record<string, unknown>[];
    audit: Record<string, unknown>[];
    [key: string]: unknown;
  }
  const mutated = (change: (document: Document) => void): { text: string; label: string } => {
    const plan = newPlan();
    const document = JSON.parse(plan.document) as Document;
    change(document);
    return { text: JSON.stringify(document), label: plan.label };
  };

  const grantOf = (document: Document, at: number): Record<string, unknown> =>
    document.administrators[at]?.grant as Record<string, unknown>;

  // Break caught: each rule of the document left to the table's own checks, which would let a pair that is not two identities with
  // their own secrets and their own events (or a mismatched ledger) through to the point of the first insert that notices.
  const CASES: readonly (readonly [string, (document: Document) => void])[] = [
    [
      'an extra key',
      (d) => {
        d.extra = 1;
      },
    ],
    [
      'no audit key',
      (d) => {
        delete (d as Partial<Document>).audit;
      },
    ],
    [
      'administrators that are not a list',
      (d) => {
        (d as Record<string, unknown>).administrators = {};
      },
    ],
    [
      'one administrator',
      (d) => {
        d.administrators.pop();
      },
    ],
    [
      'three administrators',
      (d) => {
        d.administrators.push({ ...d.administrators[0] });
      },
    ],
    [
      'the same work email twice',
      (d) => {
        must(d.administrators[1]).work_email_canonical = must(
          d.administrators[0],
        ).work_email_canonical;
      },
    ],
    [
      'the same identifier twice',
      (d) => {
        must(d.administrators[1]).id = must(d.administrators[0]).id;
      },
    ],
    [
      'an identifier that is not a uuid',
      (d) => {
        must(d.administrators[0]).id = 'not-a-uuid';
      },
    ],
    [
      'a grant identifier that is not a uuid',
      (d) => {
        grantOf(d, 0).id = '1234';
      },
    ],
    [
      'no grant',
      (d) => {
        delete must(d.administrators[0]).grant;
      },
    ],
    [
      'a hash that is not 64 hex digits',
      (d) => {
        grantOf(d, 0).token_hash = 'abcd';
      },
    ],
    [
      'a hash that is not hex',
      (d) => {
        grantOf(d, 0).token_hash = 'z'.repeat(64);
      },
    ],
    [
      'the same hash for both administrators',
      (d) => {
        grantOf(d, 1).token_hash = grantOf(d, 0).token_hash;
      },
    ],
    [
      'a name that is not text',
      (d) => {
        must(d.administrators[0]).full_name = 7;
      },
    ],
    [
      'five events',
      (d) => {
        d.audit.pop();
      },
    ],
    [
      'seven events',
      (d) => {
        d.audit.push({ ...d.audit[0] });
      },
    ],
    [
      'an event of a code the bootstrap does not write',
      (d) => {
        must(d.audit[0]).event_code = 'auth.session.failed';
      },
    ],
    [
      'two creations for one identity',
      (d) => {
        const created = d.audit.filter((e) => e.event_code === 'staff.identity.created');
        must(created[1]).object_id = must(created[0]).object_id;
      },
    ],
    [
      'an event that names an object the run did not create',
      (d) => {
        must(d.audit[0]).object_id = randomUUID();
      },
    ],
    [
      'an event recorded for a person',
      (d) => {
        must(d.audit[0]).actor_type = 'STAFF';
        must(d.audit[0]).actor_id = randomUUID();
      },
    ],
    // The actor type alone, with no id: the table refuses such a row (SYSTEM has no id and nobody else is without one), and the
    // function must refuse it first and in its own words.
    [
      'an event recorded for a person, with no identifier',
      (d) => {
        must(d.audit[0]).actor_type = 'STAFF';
      },
    ],
    [
      'an event of another surface',
      (d) => {
        must(d.audit[0]).surface_context = 'OPS_PORTAL';
      },
    ],
    [
      'an event of a failed act',
      (d) => {
        must(d.audit[0]).outcome = 'FAILED';
      },
    ],
    [
      'a creation recorded as ordinary',
      (d) => {
        must(d.audit.find((e) => e.event_code === 'staff.identity.created')).enhanced = false;
      },
    ],
    [
      'an approval recorded as ordinary',
      (d) => {
        must(d.audit.find((e) => e.event_code === 'staff.identity.approved')).enhanced = false;
      },
    ],
    [
      'an issue recorded as enhanced',
      (d) => {
        must(d.audit.find((e) => e.event_code === 'auth.setup_grant.issued')).enhanced = true;
      },
    ],
  ];

  it.each(CASES)('refuses %s (22023) and writes nothing', async (_name, change) => {
    const { text, label } = mutated(change);
    const failure = await refusalOf(() => seed(text));
    expect(failure.code).toBe('22023');
    expect(failure.message).not.toMatch(/@melarc\.example/);
    expect(await leftBy(label)).toEqual({ staff: 0, grants: 0, audit: 0 });
  });

  it('refuses a document that is not an object, or is nothing', async () => {
    for (const text of ['[]', '1', '"x"', 'null']) {
      expect((await refusalOf(() => seed(text))).code, text).toBe('22023');
    }
    const failure = await refusalOf(() => asProvisioning((client) => client.query(SEED, [null])));
    expect(failure.code).toBe('22023');
    expect(await count('staff_identity')).toBe(0);
  });

  // Break caught: a function that is atomic only when its own checks refuse: a failure at the last insert (an event the table
  // refuses) must take the identities and the grants with it.
  it('takes the identities and the grants with it when the ledger refuses an event', async () => {
    const { text, label } = mutated((d) => {
      must(d.audit[5]).correlation_id = '';
    });
    const failure = await refusalOf(() => seed(text));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('audit_event_correlation_bounded');
    expect(await leftBy(label)).toEqual({ staff: 0, grants: 0, audit: 0 });
  });

  it('refuses a run that is not at read committed isolation, because a snapshot taken before the wait would count the table as empty', async () => {
    const plan = newPlan();
    const failure = await refusalOf(() =>
      asProvisioning(async (client) => {
        await client.query('begin isolation level repeatable read');
        try {
          await client.query(SEED, [plan.document]);
        } finally {
          await client.query('rollback');
        }
      }),
    );
    expect(failure.code).toBe('25000');
    expect(await count('staff_identity')).toBe(0);
  });
});

/** A bootstrap identity as the seed leaves it, and the means to move it along the walk of §3.3 as the administrator. */
async function seededPair() {
  const plan = newPlan();
  await seed(plan.document);
  const [first, second] = plan.administrators;
  if (first === undefined || second === undefined)
    throw new Error('the plan has two administrators');
  return { plan, first, second };
}

/** The identity has set a password (the setup grant is consumed) and holds a factor that was never proven. */
async function strandAfterEnrolment(
  identityId: string,
  grantId: string,
  options: { lapsed?: boolean } = {},
): Promise<{ factorId: string; continuationId: string }> {
  await setGrantState(admin, grantId, 'CONSUMED');
  await admin.query(
    `update staff_identity set credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA', credential_established_at = clock_timestamp(), credential_generation = 1 where id = $1`,
    [identityId],
  );
  const factor = await insertFactor(
    admin,
    factorRow(identityId, { createdByPurpose: 'BOOTSTRAP_SETUP' }),
  );
  const issuedAt = new Date(Date.now() - (options.lapsed === false ? 60_000 : 45 * 60_000));
  const continuation = await insertGrant(
    admin,
    grantRow({
      principalId: identityId,
      purpose: 'MFA_ENROLMENT',
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 30 * 60_000),
    }),
  );
  return { factorId: factor.id, continuationId: continuation.id };
}

interface State {
  readonly id: string;
  readonly origin: string;
  readonly status: string;
  readonly credential_established: boolean;
  readonly pending_factor_ids: string[];
  readonly live_bootstrap_grant_id: string | null;
  readonly lapsed_grants: { id: string; purpose: string }[];
}

const stateOf = async (email: string): Promise<IdentityState> => {
  const result = await asProvisioning((client) => client.query<{ state: State }>(STATE, [email]));
  const state = result.rows[0]?.state;
  if (state === undefined) throw new Error('no state');
  return {
    id: state.id,
    credentialEstablished: state.credential_established,
    pendingFactorIds: state.pending_factor_ids,
    liveBootstrapGrantId: state.live_bootstrap_grant_id,
    lapsedGrants: state.lapsed_grants,
  };
};

const resume = (document: string) =>
  asProvisioning((client) => client.query<{ report: Record<string, unknown> }>(RESUME, [document]));

const planFor = (state: IdentityState, label = correlation()) =>
  planResume(state, { tokens, clock, correlationId: label });

describe('the identity state function', () => {
  it('says what decides the path, and nothing about a credential', async () => {
    const { first } = await seededPair();
    const state = (
      await asProvisioning((client) =>
        client.query<{ state: State }>(STATE, [first.workEmailCanonical]),
      )
    ).rows[0]?.state;
    expect(state).toEqual({
      id: first.id,
      origin: 'BOOTSTRAP',
      status: 'ACTIVE',
      full_name: first.fullName,
      work_email: first.workEmail,
      credential_established: false,
      pending_factor_ids: [],
      live_bootstrap_grant_id: first.grantId,
      lapsed_grants: [],
    });
    // The name and the address as entered, so that the bundle names its custodian; never a credential or a hash.
    expect(JSON.stringify(state)).not.toMatch(/hash|secret|credential_hash/i);
  });

  it('says a stranded identity has a password, a pending factor and no live grant once the continuation has lapsed', async () => {
    const { first } = await seededPair();
    const { factorId, continuationId } = await strandAfterEnrolment(first.id, first.grantId);
    expect(await stateOf(first.workEmailCanonical)).toEqual({
      id: first.id,
      credentialEstablished: true,
      pendingFactorIds: [factorId],
      liveBootstrapGrantId: null,
      // the lapsed continuation is named with its purpose: the resume ends it as EXPIRED and its summary says so
      lapsedGrants: [{ id: continuationId, purpose: 'MFA_ENROLMENT' }],
    });
  });

  it('refuses an address that no identity has, and an identity that is not a bootstrap identity', async () => {
    await seededPair();
    const none = await refusalOf(() =>
      asProvisioning((client) => client.query(STATE, ['nobody@melarc.example'])),
    );
    expect(none.code).toBe('55000');
    expect(none.detail).toBe('reason=NO_SUCH_IDENTITY');
    const ordinary = await insertStaff(admin, staffRow());
    const failure = await refusalOf(() =>
      asProvisioning((client) => client.query(STATE, [ordinary.workEmailCanonical])),
    );
    expect(failure.code).toBe('55000');
    expect(failure.detail).toBe('reason=NOT_BOOTSTRAP_IDENTITY');
  });

  // Break caught: a state read that takes no lock, which lets a sign-in's own setup race the resume between the read and the write.
  it('holds the identity until the transaction ends, as the issue protocol of the credential operations does', async () => {
    const { first } = await seededPair();
    const holder = clientFor(database.urlFor(PROVISIONING_ROLE));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(STATE, [first.workEmailCanonical]);
      const locked = await refusalOf(() =>
        withClient(database.urlFor('postgres'), async (client) => {
          await client.query("set lock_timeout = '300ms'");
          await client.query('select id from staff_identity where id = $1 for no key update', [
            first.id,
          ]);
        }),
      );
      expect(locked.code).toBe('55P03');
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
  });
});

describe('the resume function: the stranded identity (conditions 1 to 6)', () => {
  it('issues a fresh MFA_REENROLMENT, revokes the stale PENDING factor and supersedes nothing it is not entitled to', async () => {
    const { first, second } = await seededPair();
    const { factorId, continuationId } = await strandAfterEnrolment(first.id, first.grantId);
    const plan = planFor(await stateOf(first.workEmailCanonical));
    const report = (await resume(plan.document)).rows[0]?.report;
    expect(report).toMatchObject({
      path: 'REENROLMENT',
      grant_id: plan.grantId,
      purpose: 'MFA_REENROLMENT',
      revoked_factor_ids: [factorId],
    });
    // The issue and the expiry the bundle will state are the database's: thirty minutes apart, the setting's lifetime.
    const times = report;
    const issued = new Date(String(times?.issued_at)).getTime();
    const expires = new Date(String(times?.expires_at)).getTime();
    expect(expires - issued).toBe(30 * 60_000);

    const grant = (
      await admin.query<Record<string, unknown>>(
        `select principal_type, principal_id, purpose, state, issued_by, episode_id, supersedes_grant_id, continued_from_grant_id,
                (expires_at - issued_at) as lifetime, encode(token_hash, 'hex') as hash
           from setup_grant where id = $1`,
        [plan.grantId],
      )
    ).rows[0];
    expect(grant).toMatchObject({
      principal_type: 'STAFF',
      principal_id: first.id,
      purpose: 'MFA_REENROLMENT',
      state: 'PENDING',
      issued_by: null,
      episode_id: null,
      supersedes_grant_id: null,
      continued_from_grant_id: null,
      hash: Buffer.from(tokens.hash(plan.secret) ?? []).toString('hex'),
    });
    // The lifetime is the setting recovery_link_ttl_minutes (30), read by the function and never a figure of its own.
    expect(grant?.lifetime).toEqual({ minutes: 30 });

    const factor = (
      await admin.query<Record<string, unknown>>(
        'select status, revoked_at, revoked_by, revocation_reason_code, revocation_episode_id from mfa_factor where id = $1',
        [factorId],
      )
    ).rows[0];
    expect(factor).toMatchObject({
      status: 'REVOKED',
      revoked_by: null,
      revocation_reason_code: null,
      revocation_episode_id: null,
    });
    expect(factor?.revoked_at).toBeInstanceOf(Date);

    // The lapsed continuation was ended on its expiry; nothing of the other administrator moved.
    const lapsed = (
      await admin.query<{ state: string }>('select state from setup_grant where id = $1', [
        continuationId,
      ])
    ).rows[0];
    expect(lapsed?.state).toBe('EXPIRED');
    const other = (
      await admin.query<{ state: string }>('select state from setup_grant where id = $1', [
        second.grantId,
      ])
    ).rows[0];
    expect(other?.state).toBe('PENDING');
    // No password reset or revealed, no session granted, no factor activated, BOOTSTRAP_SETUP not resurrected.
    expect(await count('session')).toBe(0);
    expect(
      Number(await scalar(admin, "select count(*)::int from mfa_factor where status = 'ACTIVE'")),
    ).toBe(0);
    expect(
      Number(
        await scalar(admin, 'select credential_generation from staff_identity where id = $1', [
          first.id,
        ]),
      ),
    ).toBe(1);
    expect(
      Number(
        await scalar(
          admin,
          "select count(*)::int from setup_grant where purpose = 'BOOTSTRAP_SETUP' and state = 'PENDING' and principal_id = $1",
          [first.id],
        ),
      ),
    ).toBe(0);
  });

  it('writes the revocation (enhanced), the issue and the enhanced summary under SYSTEM, in the one transaction of the change', async () => {
    const { first } = await seededPair();
    const { factorId } = await strandAfterEnrolment(first.id, first.grantId);
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    await resume(plan.document);
    const events = (
      await admin.query<Record<string, unknown>>(
        'select event_code, object_type, object_id, enhanced, actor_type, actor_id, xmin::text as tx from audit_event where correlation_id = $1 order by event_code',
        [label],
      )
    ).rows;
    expect(events.map((event) => [event.event_code, event.object_id, event.enhanced])).toEqual([
      ['auth.bootstrap.resumed', first.id, true],
      ['auth.mfa.revoked', factorId, true],
      ['auth.setup_grant.issued', plan.grantId, false],
    ]);
    for (const event of events)
      expect(event).toMatchObject({ actor_type: 'SYSTEM', actor_id: null });
    const grantTx = await scalar<string>(
      admin,
      'select xmin::text from setup_grant where id = $1',
      [plan.grantId],
    );
    expect(new Set([...events.map((event) => event.tx), grantTx]).size).toBe(1);
  });

  it('issues a grant when the identity holds no factor at all (a factor revoked by an administrator, the re-enrolment lapsed)', async () => {
    const { first } = await seededPair();
    const { factorId } = await strandAfterEnrolment(first.id, first.grantId);
    await admin.query(
      "update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1",
      [factorId],
    );
    const plan = planFor(await stateOf(first.workEmailCanonical));
    expect((await resume(plan.document)).rows[0]?.report).toMatchObject({
      path: 'REENROLMENT',
      revoked_factor_ids: [],
    });
  });

  it('works for either administrator on its own, whether or not the other is ready', async () => {
    const { first, second } = await seededPair();
    await strandAfterEnrolment(second.id, second.grantId);
    const plan = planFor(await stateOf(second.workEmailCanonical));
    await resume(plan.document);
    expect(
      Number(
        await scalar(
          admin,
          "select count(*)::int from setup_grant where principal_id = $1 and purpose = 'MFA_REENROLMENT'",
          [second.id],
        ),
      ),
    ).toBe(1);
    expect(
      Number(
        await scalar(
          admin,
          "select count(*)::int from setup_grant where principal_id = $1 and purpose = 'MFA_REENROLMENT'",
          [first.id],
        ),
      ),
    ).toBe(0);
  });

  // Break caught: each condition of §3.3a left to the command, so that code running as the provisioning login could resume an
  // identity the section says it never may.
  describe('refuses, writing nothing', () => {
    async function refusedWith(
      arrange: (ids: { first: string; grant: string; second: string }) => Promise<void>,
    ) {
      const { first, second } = await seededPair();
      const { factorId } = await strandAfterEnrolment(first.id, first.grantId);
      const state = await stateOf(first.workEmailCanonical);
      await arrange({ first: first.id, grant: first.grantId, second: second.id });
      const before = JSON.stringify([
        (await admin.query('select id, state from setup_grant order by id')).rows,
        (await admin.query('select id, status from mfa_factor order by id')).rows,
      ]);
      const label = correlation();
      const plan = planFor(state, label);
      const failure = await refusalOf(() => resume(plan.document));
      expect(failure.code).toBe('55000');
      const after = JSON.stringify([
        (await admin.query('select id, state from setup_grant order by id')).rows,
        (await admin.query('select id, status from mfa_factor order by id')).rows,
      ]);
      expect(after).toBe(before);
      expect(
        Number(
          await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
            label,
          ]),
        ),
      ).toBe(0);
      expect(factorId).toBeTruthy();
      return failure;
    }

    it('condition 1: an identity whose origin is not BOOTSTRAP, though it holds a password and a pending factor and the reserved actor as maker', async () => {
      const failure = await refusedWith(async ({ first }) => {
        // Origin is immutable (a trigger), and so is a checker once written (the state machine of S0.36), so the identity is arranged with
        // both triggers off: a MAKER_CHECKER identity whose maker is the reserved actor, to show that the rule reads the column and never
        // the actor.
        await admin.query('alter table staff_identity disable trigger staff_identity_guard');
        await admin.query('alter table staff_identity disable trigger staff_identity_transition');
        await admin.query(
          "update staff_identity set origin = 'MAKER_CHECKER', approved_by = $2 where id = $1",
          [first, randomUUID()],
        );
        await admin.query('alter table staff_identity enable trigger staff_identity_transition');
        await admin.query('alter table staff_identity enable trigger staff_identity_guard');
      });
      expect(failure.detail).toBe('reason=NOT_BOOTSTRAP_IDENTITY');
    });

    it('condition 2: an offboarded identity', async () => {
      const failure = await refusedWith(async ({ first }) => {
        await admin.query("update staff_identity set status = 'OFFBOARDED' where id = $1", [first]);
      });
      expect(failure.detail).toBe('reason=OFFBOARDED');
    });

    it('conditions 4 and 6: an identity that holds an ACTIVE factor, the moment it holds it', async () => {
      const failure = await refusedWith(async ({ first }) => {
        const active = await insertFactor(
          admin,
          factorRow(first, { createdByPurpose: 'MFA_REENROLMENT' }),
        );
        await admin.query(
          "update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where staff_identity_id = $1 and status = 'PENDING' and id <> $2",
          [first, active.id],
        );
        await activateFactor(admin, active.id);
      });
      expect(failure.detail).toBe('reason=ACTIVE_FACTOR');
    });

    it('condition 5: an identity with a live session', async () => {
      const failure = await refusedWith(async ({ first }) => {
        await insertSessionRow(admin, sessionRow({ principalId: first }));
      });
      expect(failure.detail).toBe('reason=LIVE_SESSION');
    });

    it('a live setup grant: the continuation is still in its thirty minutes, so the identity is not stranded', async () => {
      const failure = await refusedWith(async ({ first }) => {
        await insertGrant(admin, grantRow({ principalId: first, purpose: 'MFA_REENROLMENT' }));
      });
      expect(failure.detail).toBe('reason=LIVE_GRANT');
    });

    it('a recovery lifetime nobody seeded: the setting is read and never defaulted', async () => {
      const { first } = await seededPair();
      await strandAfterEnrolment(first.id, first.grantId);
      const plan = planFor(await stateOf(first.workEmailCanonical));
      await admin.query('alter table setting disable trigger user');
      const saved = (
        await admin.query('select * from setting where key = $1', ['recovery_link_ttl_minutes'])
      ).rows[0] as Record<string, unknown>;
      await admin.query('delete from setting where key = $1', ['recovery_link_ttl_minutes']);
      try {
        const failure = await refusalOf(() => resume(plan.document));
        expect(failure.detail).toBe('reason=SETTING_MISSING');
        expect(
          Number(
            await scalar(
              admin,
              "select count(*)::int from setup_grant where purpose = 'MFA_REENROLMENT'",
            ),
          ),
        ).toBe(0);
      } finally {
        await admin.query(
          'insert into setting (key, scope, value_type, value, unit, description) values ($1, $2, $3, $4, $5, $6)',
          [
            saved.key,
            saved.scope,
            saved.value_type,
            JSON.stringify(saved.value),
            saved.unit,
            saved.description,
          ],
        );
        await admin.query('alter table setting enable trigger user');
      }
    });

    it('an identity that changed between the read and the change: the path the plan took is not the state', async () => {
      const { first } = await seededPair();
      await strandAfterEnrolment(first.id, first.grantId);
      const plan = planFor(await stateOf(first.workEmailCanonical));
      // The administrator sets a second pending factor after the state was read: the plan names one factor, the identity holds two.
      await insertFactor(admin, factorRow(first.id, { createdByPurpose: 'MFA_REENROLMENT' }));
      const failure = await refusalOf(() => resume(plan.document));
      expect(failure.detail).toBe('reason=STATE_CHANGED');
      expect(
        Number(
          await scalar(admin, "select count(*)::int from mfa_factor where status = 'REVOKED'"),
        ),
      ).toBe(0);
    });
  });

  it('refuses an identity that does not exist', async () => {
    await seededPair();
    const plan = planFor({
      id: randomUUID(),
      credentialEstablished: true,
      pendingFactorIds: [],
      liveBootstrapGrantId: null,
      lapsedGrants: [],
    });
    const failure = await refusalOf(() => resume(plan.document));
    expect(failure.detail).toBe('reason=NO_SUCH_IDENTITY');
  });
});

/**
 * The summary event of a resume (the owner's adoption of 21 October 2026, A07; AC-SLICE-000-93; audit.md §5.4, *Facts of
 * `auth.bootstrap.resumed`*): one enhanced event, by SYSTEM with no actor id, per committed resume, on both paths, in the transaction of the
 * change. **The function derives its facts from what it wrote**, and a document whose summary says anything else is refused with nothing
 * written. The detailed events are written beside it and are not replaced.
 */
describe('the resume function: the summary event', () => {
  const RESUMED = 'auth.bootstrap.resumed';

  interface Written {
    readonly event_code: string;
    readonly object_type: string;
    readonly object_id: string;
    readonly enhanced: boolean;
    readonly actor_type: string;
    readonly actor_id: string | null;
    readonly outcome: string;
    readonly before_after: Record<string, unknown> | null;
    readonly related_ids: Record<string, unknown>;
    readonly detail: Record<string, unknown>;
    readonly tx: string;
  }

  const writtenBy = async (label: string): Promise<Written[]> =>
    (
      await admin.query<Written>(
        `select event_code, object_type, object_id, enhanced, actor_type, actor_id, outcome, before_after, related_ids, detail, xmin::text as tx
           from audit_event where correlation_id = $1 order by event_code, object_id`,
        [label],
      )
    ).rows;
  const summaryOf = async (label: string): Promise<Written> => {
    const rows = (await writtenBy(label)).filter((event) => event.event_code === RESUMED);
    expect(rows).toHaveLength(1);
    return must(rows[0]);
  };
  const stateOfGrant = async (id: string): Promise<string | undefined> =>
    (await admin.query<{ state: string }>('select state from setup_grant where id = $1', [id]))
      .rows[0]?.state;
  const statusOfFactor = async (id: string): Promise<string | undefined> =>
    (await admin.query<{ status: string }>('select status from mfa_factor where id = $1', [id]))
      .rows[0]?.status;

  // Break caught: a summary that is not the database's own: the grants, the factors and their states are read back from the tables
  // after the resume and must be what the event says, so an event invented by the plan could not agree with them by accident.
  it('records, on the re-enrolment, the grants it ended, the grant it issued and the factors it revoked, as the tables hold them', async () => {
    const { first } = await seededPair();
    const { factorId, continuationId } = await strandAfterEnrolment(first.id, first.grantId);
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    await resume(plan.document);

    const event = await summaryOf(label);

    expect(event).toMatchObject({
      object_type: 'StaffIdentity',
      object_id: first.id,
      enhanced: true,
      actor_type: 'SYSTEM',
      actor_id: null,
      outcome: 'SUCCEEDED',
    });
    expect(event.detail).toEqual({
      path: 'REENROLMENT',
      purpose: 'MFA_REENROLMENT',
      channel: 'PROVISIONING_CHANNEL',
    });
    expect(event.related_ids).toEqual({
      principal_id: first.id,
      reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_ID,
      setup_grant_id: plan.grantId,
      superseded_grant_ids: [],
      expired_grant_ids: [continuationId],
      revoked_factor_ids: [factorId],
    });
    // and the tables agree with the states it records after
    expect(await stateOfGrant(continuationId)).toBe('EXPIRED');
    expect(await stateOfGrant(plan.grantId)).toBe('PENDING');
    expect(await statusOfFactor(factorId)).toBe('REVOKED');
    expect(event.before_after).toEqual({
      grants: {
        before: [{ id: continuationId, purpose: 'MFA_ENROLMENT', state: 'PENDING' }],
        after: [
          { id: continuationId, purpose: 'MFA_ENROLMENT', state: 'EXPIRED' },
          { id: plan.grantId, purpose: 'MFA_REENROLMENT', state: 'PENDING' },
        ],
      },
      factors: {
        before: [{ id: factorId, status: 'PENDING' }],
        after: [{ id: factorId, status: 'REVOKED' }],
      },
    });
  });

  it('records, on the lost bundle, the secret it superseded and the one it issued', async () => {
    const { first } = await seededPair();
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    await resume(plan.document);

    const event = await summaryOf(label);

    expect(event.detail).toEqual({
      path: 'BUNDLE_LOST',
      purpose: 'BOOTSTRAP_SETUP',
      channel: 'PROVISIONING_CHANNEL',
    });
    expect(event.related_ids).toEqual({
      principal_id: first.id,
      reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_ID,
      setup_grant_id: plan.grantId,
      superseded_grant_ids: [first.grantId],
      expired_grant_ids: [],
      revoked_factor_ids: [],
    });
    expect(await stateOfGrant(first.grantId)).toBe('SUPERSEDED');
    expect(await stateOfGrant(plan.grantId)).toBe('PENDING');
    expect(event.before_after).toEqual({
      grants: {
        before: [{ id: first.grantId, purpose: 'BOOTSTRAP_SETUP', state: 'PENDING' }],
        after: [
          { id: first.grantId, purpose: 'BOOTSTRAP_SETUP', state: 'SUPERSEDED' },
          { id: plan.grantId, purpose: 'BOOTSTRAP_SETUP', state: 'PENDING' },
        ],
      },
      factors: { before: [], after: [] },
    });
  });

  it('writes nothing of the changes but the facts of the one act: the reserved actor is a fact, never the actor', async () => {
    const { first } = await seededPair();
    const label = correlation();
    await resume(planFor(await stateOf(first.workEmailCanonical), label).document);

    const event = await summaryOf(label);

    expect(event.actor_id).toBeNull();
    expect(event.related_ids.reserved_system_actor_id).toBe(RESERVED_SYSTEM_ACTOR_ID);
    expect(
      Number(
        await scalar(admin, 'select count(*)::int from audit_event where actor_id = $1', [
          RESERVED_SYSTEM_ACTOR_ID,
        ]),
      ),
    ).toBe(0);
  });

  // Break caught: a summary written beside the detailed events in a transaction of its own (or after), which would let a change commit
  // with no record of it, or a record commit with no change.
  it('is written in the one transaction of the change, beside the detailed events, and replaces none of them', async () => {
    const { first } = await seededPair();
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    await resume(plan.document);

    const events = await writtenBy(label);

    expect(events.map((event) => event.event_code)).toEqual([
      'auth.bootstrap.resumed',
      'auth.setup_grant.issued',
      'auth.setup_grant.superseded',
    ]);
    const grantTx = await scalar<string>(
      admin,
      'select xmin::text from setup_grant where id = $1',
      [plan.grantId],
    );
    expect(new Set([...events.map((event) => event.tx), grantTx]).size).toBe(1);
  });

  // Break caught: a summary per attempted invocation, or two for one commit; AC-SLICE-000-93 asks for one record per resume.
  it('is written exactly once per committed resume, and each later resume writes its own', async () => {
    const { first } = await seededPair();
    const one = correlation();
    const two = correlation();
    await resume(planFor(await stateOf(first.workEmailCanonical), one).document);
    await resume(planFor(await stateOf(first.workEmailCanonical), two).document);

    expect((await writtenBy(one)).filter((event) => event.event_code === RESUMED)).toHaveLength(1);
    expect((await writtenBy(two)).filter((event) => event.event_code === RESUMED)).toHaveLength(1);
    expect(
      Number(
        await scalar(
          admin,
          "select count(*)::int from audit_event where event_code = 'auth.bootstrap.resumed' and object_id = $1",
          [first.id],
        ),
      ),
    ).toBe(2);
  });

  // Break caught: a summary for a refusal: a resume that was refused changed nothing and is not this event.
  it('is not written for a resume that is refused', async () => {
    const { first } = await seededPair();
    await strandAfterEnrolment(first.id, first.grantId, { lapsed: false });
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);

    const failure = await refusalOf(() => resume(plan.document));

    expect(failure.detail).toBe('reason=LIVE_GRANT');
    expect(await writtenBy(label)).toEqual([]);
    // (the ledger is append-only and holds the summaries of the other tests: this identity is new, and has none)
    expect(
      Number(
        await scalar(
          admin,
          "select count(*)::int from audit_event where event_code = 'auth.bootstrap.resumed' and object_id = $1",
          [first.id],
        ),
      ),
    ).toBe(0);
  });

  // Break caught: the summary inserted outside the change's transaction, or its failure swallowed, so that a change could stand with no
  // summary. The insert of the summary is made to fail, and the grant, the supersession, the revocation and every event go with it.
  it('takes the whole change back when the summary cannot be written', async () => {
    const { first } = await seededPair();
    const { factorId, continuationId } = await strandAfterEnrolment(first.id, first.grantId);
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    await admin.query(`
      create function public.melarc_test_refuse_summary() returns trigger language plpgsql as
        $$ begin raise exception 'the summary is refused by the test' using errcode = 'P0001'; end $$`);
    await admin.query(`
      create trigger melarc_test_refuse_summary before insert on audit_event
        for each row when (new.event_code = 'auth.bootstrap.resumed')
        execute function public.melarc_test_refuse_summary()`);
    try {
      const failure = await refusalOf(() => resume(plan.document));
      expect(failure.code).toBe('P0001');
    } finally {
      await admin.query('drop trigger melarc_test_refuse_summary on audit_event');
      await admin.query('drop function public.melarc_test_refuse_summary()');
    }

    expect(await writtenBy(label)).toEqual([]);
    expect(await stateOfGrant(plan.grantId)).toBeUndefined();
    expect(await stateOfGrant(continuationId)).toBe('PENDING');
    expect(await statusOfFactor(factorId)).toBe('PENDING');
  });

  describe('a summary whose facts are not what the resume changed', () => {
    interface Document {
      audit: Record<string, unknown>[];
      [key: string]: unknown;
    }
    async function documentOf(lost: boolean): Promise<{ document: Document; label: string }> {
      const { first } = await seededPair();
      if (!lost) await strandAfterEnrolment(first.id, first.grantId);
      const label = correlation();
      return {
        document: JSON.parse(
          planFor(await stateOf(first.workEmailCanonical), label).document,
        ) as Document,
        label,
      };
    }
    const summaryRow = (document: Document): Record<string, unknown> =>
      must(document.audit.find((event) => event.event_code === RESUMED));
    const facts = (document: Document, key: 'related_ids' | 'before_after' | 'detail') =>
      summaryRow(document)[key] as Record<string, unknown>;

    const TAMPERING: readonly (readonly [string, boolean, (document: Document) => void])[] = [
      [
        'a grant that was not ended',
        false,
        (d) => {
          facts(d, 'related_ids').expired_grant_ids = [randomUUID()];
        },
      ],
      [
        'a factor that was not revoked',
        false,
        (d) => {
          facts(d, 'related_ids').revoked_factor_ids = [randomUUID()];
        },
      ],
      [
        'a revoked factor that is left out',
        false,
        (d) => {
          facts(d, 'related_ids').revoked_factor_ids = [];
        },
      ],
      [
        'a grant that is not the one issued',
        false,
        (d) => {
          facts(d, 'related_ids').setup_grant_id = randomUUID();
        },
      ],
      [
        'another principal',
        false,
        (d) => {
          facts(d, 'related_ids').principal_id = randomUUID();
        },
      ],
      // Break caught: the reserved actor taken on trust from the document instead of from the database.
      [
        'a reserved actor that is not the reserved one',
        false,
        (d) => {
          facts(d, 'related_ids').reserved_system_actor_id = randomUUID();
        },
      ],
      [
        'a fact that is not defined',
        false,
        (d) => {
          facts(d, 'related_ids').invented_id = randomUUID();
        },
      ],
      [
        'another path',
        false,
        (d) => {
          facts(d, 'detail').path = 'BUNDLE_LOST';
        },
      ],
      [
        'another purpose',
        false,
        (d) => {
          facts(d, 'detail').purpose = 'BOOTSTRAP_SETUP';
        },
      ],
      [
        'another channel',
        false,
        (d) => {
          facts(d, 'detail').channel = 'EMAIL';
        },
      ],
      [
        'a before and after with no change in it',
        false,
        (d) => {
          summaryRow(d).before_after = {
            grants: { before: [], after: [] },
            factors: { before: [], after: [] },
          };
        },
      ],
      [
        'a factor that did not end revoked',
        false,
        (d) => {
          const diff = facts(d, 'before_after') as { factors: { after: { status: string }[] } };
          must(diff.factors.after[0]).status = 'PENDING';
        },
      ],
      [
        'a grant that did not end as the tables hold it',
        false,
        (d) => {
          const diff = facts(d, 'before_after') as { grants: { after: { state: string }[] } };
          must(diff.grants.after[0]).state = 'SUPERSEDED';
        },
      ],
      [
        'a superseded grant on the lost bundle that is not the live one',
        true,
        (d) => {
          facts(d, 'related_ids').superseded_grant_ids = [randomUUID()];
        },
      ],
    ];

    // Break caught: the function writing a summary that the plan composed, whatever it says, instead of the facts of its own changes.
    it.each(TAMPERING)(
      'refuses %s as a changed state, and writes nothing',
      async (_name, lost, change) => {
        const { document, label } = await documentOf(lost);
        change(document);

        const failure = await refusalOf(() => resume(JSON.stringify(document)));

        expect(failure.code).toBe('55000');
        expect(failure.detail).toBe('reason=STATE_CHANGED');
        expect(await writtenBy(label)).toEqual([]);
        expect(
          Number(
            await scalar(
              admin,
              "select count(*)::int from setup_grant where purpose in ('MFA_REENROLMENT') or state in ('SUPERSEDED', 'EXPIRED')",
            ),
          ),
        ).toBe(0);
      },
    );
  });

  // Break caught: a secret, a hash, an address or a name reaching the ledger through the summary.
  it('holds no secret, hash, address or name', async () => {
    const { first } = await seededPair();
    await strandAfterEnrolment(first.id, first.grantId);
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    await resume(plan.document);

    const text = JSON.stringify(await summaryOf(label));

    expect(text).not.toContain(plan.secret);
    expect(text).not.toContain(Buffer.from(tokens.hash(plan.secret) ?? []).toString('hex'));
    expect(text).not.toContain(first.workEmail);
    expect(text).not.toContain(first.fullName);
    expect(text).not.toMatch(/@|secret|token|password/i);
  });
});

describe('the resume function: a bundle lost before a password exists', () => {
  it('supersedes the unconsumed BOOTSTRAP_SETUP with a new one, names the old one, and revives nothing', async () => {
    const { first, second } = await seededPair();
    const plan = planFor(await stateOf(first.workEmailCanonical));
    expect(plan.path).toBe('BUNDLE_LOST');
    const report = (await resume(plan.document)).rows[0]?.report;
    expect(report).toMatchObject({
      path: 'BUNDLE_LOST',
      grant_id: plan.grantId,
      purpose: 'BOOTSTRAP_SETUP',
      superseded_grant_id: first.grantId,
      expires_at: null,
    });

    const grants = (
      await admin.query<{
        id: string;
        state: string;
        purpose: string;
        supersedes_grant_id: string | null;
        expires_at: Date | null;
      }>(
        'select id, state, purpose, supersedes_grant_id, expires_at from setup_grant where principal_id = $1 order by issued_at, id',
        [first.id],
      )
    ).rows;
    expect(grants).toHaveLength(2);
    expect(grants.find((grant) => grant.id === first.grantId)).toMatchObject({
      state: 'SUPERSEDED',
    });
    expect(grants.find((grant) => grant.id === plan.grantId)).toMatchObject({
      state: 'PENDING',
      purpose: 'BOOTSTRAP_SETUP',
      supersedes_grant_id: first.grantId,
      expires_at: null,
    });
    // The other administrator's secret is untouched, and still the only way in for them.
    expect(
      (
        await admin.query<{ state: string }>('select state from setup_grant where id = $1', [
          second.grantId,
        ])
      ).rows[0]?.state,
    ).toBe('PENDING');
    expect(await count('mfa_factor')).toBe(0);
  });

  it('writes the supersession and the issue as ordinary events and the summary as an enhanced one, under SYSTEM', async () => {
    const { first } = await seededPair();
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    await resume(plan.document);
    const events = (
      await admin.query<{
        event_code: string;
        object_id: string;
        enhanced: boolean;
        actor_type: string;
      }>(
        'select event_code, object_id, enhanced, actor_type from audit_event where correlation_id = $1 order by event_code',
        [label],
      )
    ).rows;
    expect(events).toEqual([
      {
        event_code: 'auth.bootstrap.resumed',
        object_id: first.id,
        enhanced: true,
        actor_type: 'SYSTEM',
      },
      {
        event_code: 'auth.setup_grant.issued',
        object_id: plan.grantId,
        enhanced: false,
        actor_type: 'SYSTEM',
      },
      {
        event_code: 'auth.setup_grant.superseded',
        object_id: first.grantId,
        enhanced: false,
        actor_type: 'SYSTEM',
      },
    ]);
  });

  // Break caught: the lost-bundle path open to an identity that already holds a password, which would revive a consumed secret.
  it('refuses to supersede a consumed secret: with a password established the path is the re-enrolment, and the plan said otherwise', async () => {
    const { first } = await seededPair();
    const lost = planFor(await stateOf(first.workEmailCanonical));
    await strandAfterEnrolment(first.id, first.grantId);
    const failure = await refusalOf(() => resume(lost.document));
    expect(failure.code).toBe('55000');
    expect(failure.detail).toBe('reason=STATE_CHANGED');
    expect(
      Number(
        await scalar(
          admin,
          "select count(*)::int from setup_grant where purpose = 'BOOTSTRAP_SETUP' and state = 'PENDING'",
        ),
      ),
    ).toBe(1);
  });

  it('can be run again: each run supersedes the secret of the one before', async () => {
    const { first } = await seededPair();
    const one = planFor(await stateOf(first.workEmailCanonical));
    await resume(one.document);
    const two = planFor(await stateOf(first.workEmailCanonical));
    expect(two.path).toBe('BUNDLE_LOST');
    await resume(two.document);
    expect(
      (
        await admin.query<{ id: string; state: string }>(
          "select id, state from setup_grant where principal_id = $1 and state = 'PENDING'",
          [first.id],
        )
      ).rows,
    ).toEqual([{ id: two.grantId, state: 'PENDING' }]);
  });

  it('refuses the same conditions as the re-enrolment path where they apply: an offboarded identity', async () => {
    const { first } = await seededPair();
    const plan = planFor(await stateOf(first.workEmailCanonical));
    await admin.query("update staff_identity set status = 'OFFBOARDED' where id = $1", [first.id]);
    expect((await refusalOf(() => resume(plan.document))).detail).toBe('reason=OFFBOARDED');
  });
});

describe('the resume function: what it refuses in the document', () => {
  interface ResumeDocument {
    identity_id: string;
    path: string;
    grant: { id: string; token_hash: string };
    audit: Record<string, unknown>[];
    [key: string]: unknown;
  }

  async function strandedDocument(): Promise<{ document: ResumeDocument; label: string }> {
    const { first } = await seededPair();
    await strandAfterEnrolment(first.id, first.grantId);
    const label = correlation();
    return {
      document: JSON.parse(
        planFor(await stateOf(first.workEmailCanonical), label).document,
      ) as ResumeDocument,
      label,
    };
  }

  const ISSUED = 'auth.setup_grant.issued';
  const RESUMED = 'auth.bootstrap.resumed';

  const CASES: readonly (readonly [string, (document: ResumeDocument) => void])[] = [
    [
      'an extra key',
      (d) => {
        d.extra = 1;
      },
    ],
    [
      'a path that is neither',
      (d) => {
        d.path = 'WHATEVER';
      },
    ],
    [
      'an identity that is not a uuid',
      (d) => {
        d.identity_id = 'x';
      },
    ],
    [
      'a hash that is not 32 bytes',
      (d) => {
        d.grant.token_hash = 'ab';
      },
    ],
    [
      'no event for the grant',
      (d) => {
        d.audit.splice(d.audit.indexOf(eventOf(d, ISSUED)), 1);
      },
    ],
    [
      'an event that is not one the resume writes',
      (d) => {
        eventOf(d, ISSUED).event_code = 'staff.identity.created';
      },
    ],
    [
      'an issue naming another grant',
      (d) => {
        eventOf(d, ISSUED).object_id = randomUUID();
      },
    ],
    // The summary of A07 (AC-SLICE-000-93): exactly one, enhanced, by SYSTEM with no actor id, about the identity.
    [
      'no summary',
      (d) => {
        d.audit.splice(d.audit.indexOf(eventOf(d, RESUMED)), 1);
      },
    ],
    [
      'two summaries',
      (d) => {
        d.audit.push({ ...eventOf(d, RESUMED), id: randomUUID() });
      },
    ],
    [
      'a summary recorded as ordinary',
      (d) => {
        eventOf(d, RESUMED).enhanced = false;
      },
    ],
    [
      'a summary recorded for a person',
      (d) => {
        eventOf(d, RESUMED).actor_type = 'STAFF';
        eventOf(d, RESUMED).actor_id = randomUUID();
      },
    ],
    // Break caught: the reserved bootstrap actor written as the actor, which the ledger's convention forbids: it is a fact of the event.
    [
      'a summary that names the reserved actor as its actor',
      (d) => {
        eventOf(d, RESUMED).actor_id = RESERVED_SYSTEM_ACTOR_ID;
      },
    ],
    [
      'a summary about another object',
      (d) => {
        eventOf(d, RESUMED).object_id = randomUUID();
      },
    ],
    [
      'a summary about a grant and not the identity',
      (d) => {
        eventOf(d, RESUMED).object_type = 'SetupGrant';
      },
    ],
    [
      'a summary with a reason',
      (d) => {
        eventOf(d, RESUMED).reason_code = 'MFA_ENROLMENT_EXPIRED';
        eventOf(d, RESUMED).reason_label = 'The enrolment could not be completed';
      },
    ],
    [
      'a summary that is a refusal',
      (d) => {
        eventOf(d, RESUMED).outcome = 'REJECTED';
      },
    ],
    [
      'an event recorded for a person',
      (d) => {
        must(d.audit[0]).actor_type = 'STAFF';
        must(d.audit[0]).actor_id = randomUUID();
      },
    ],
    [
      'an event recorded for a person, with no identifier',
      (d) => {
        must(d.audit[0]).actor_type = 'STAFF';
      },
    ],
    [
      'a revocation recorded as ordinary',
      (d) => {
        must(d.audit[0]).enhanced = false;
      },
    ],
    [
      'an issue recorded as enhanced',
      (d) => {
        eventOf(d, ISSUED).enhanced = true;
      },
    ],
    // Break caught: the count of events matching, with the same object twice: a revocation recorded twice for one factor, which
    // would write the record of one act two times (the ledger is append-only and cannot take one back).
    [
      'the same factor revoked twice in the record',
      (d) => {
        d.audit.unshift({ ...must(d.audit[0]), id: randomUUID() });
      },
    ],
  ];

  it.each(CASES)('refuses %s (22023) and writes nothing', async (_name, change) => {
    const { document, label } = await strandedDocument();
    change(document);
    const failure = await refusalOf(() => resume(JSON.stringify(document)));
    expect(failure.code).toBe('22023');
    expect(
      Number(
        await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
          label,
        ]),
      ),
    ).toBe(0);
    expect(
      Number(
        await scalar(
          admin,
          "select count(*)::int from setup_grant where purpose = 'MFA_REENROLMENT'",
        ),
      ),
    ).toBe(0);
    expect(
      Number(await scalar(admin, "select count(*)::int from mfa_factor where status = 'REVOKED'")),
    ).toBe(0);
  });

  // A revocation that names a factor the identity does not hold as PENDING cannot be told from a document that read the identity a
  // moment ago: it is a changed state, refused as one (55000), and nothing is written.
  it('refuses a revocation that names a factor the identity does not hold pending, as a changed state', async () => {
    const { document, label } = await strandedDocument();
    must(document.audit[0]).object_id = randomUUID();
    const failure = await refusalOf(() => resume(JSON.stringify(document)));
    expect(failure.code).toBe('55000');
    expect(failure.detail).toBe('reason=STATE_CHANGED');
    expect(
      Number(
        await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
          label,
        ]),
      ),
    ).toBe(0);
    expect(
      Number(await scalar(admin, "select count(*)::int from mfa_factor where status = 'REVOKED'")),
    ).toBe(0);
  });

  /** The document of a lost bundle: no password, an unconsumed secret to supersede. */
  async function lostDocument(): Promise<{ document: ResumeDocument; label: string }> {
    const { first } = await seededPair();
    const label = correlation();
    return {
      document: JSON.parse(
        planFor(await stateOf(first.workEmailCanonical), label).document,
      ) as ResumeDocument,
      label,
    };
  }

  const eventOf = (document: ResumeDocument, code: string): Record<string, unknown> =>
    must(document.audit.find((event) => event.event_code === code));

  // Break caught: the lost-bundle path taking its record on the document's word. A supersession that names another grant than the one
  // the identity holds, or none, would write an event about an act that did not happen, or leave the act with no event.
  it.each([
    [
      'a supersession that names another grant',
      (d: ResumeDocument) => {
        eventOf(d, 'auth.setup_grant.superseded').object_id = randomUUID();
      },
    ],
    [
      'no supersession at all',
      (d: ResumeDocument) => {
        d.audit = d.audit.filter((event) => event.event_code !== 'auth.setup_grant.superseded');
      },
    ],
  ])('refuses a lost-bundle document with %s, as a changed state', async (_name, change) => {
    const { document, label } = await lostDocument();
    change(document);
    const failure = await refusalOf(() => resume(JSON.stringify(document)));
    expect(failure.code).toBe('55000');
    expect(failure.detail).toBe('reason=STATE_CHANGED');
    expect(
      Number(
        await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
          label,
        ]),
      ),
    ).toBe(0);
    expect(
      Number(
        await scalar(admin, "select count(*)::int from setup_grant where state = 'SUPERSEDED'"),
      ),
    ).toBe(0);
  });

  // Break caught: an enhanced event that no act of the path backs: a revocation of a factor smuggled into a lost-bundle document (no
  // factor exists on that path), or a supersession smuggled into a re-enrolment (nothing is superseded there). The ledger is
  // append-only: a forged enhanced record could not be taken back.
  it('refuses an event the path does not write, whichever the path', async () => {
    const lost = await lostDocument();
    lost.document.audit.unshift({
      ...eventOf(lost.document, 'auth.setup_grant.issued'),
      id: randomUUID(),
      event_code: 'auth.mfa.revoked',
      object_type: 'MfaFactor',
      object_id: randomUUID(),
      enhanced: true,
    });
    const forged = await refusalOf(() => resume(JSON.stringify(lost.document)));
    expect(forged.code).toBe('22023');
    expect(
      Number(
        await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
          lost.label,
        ]),
      ),
    ).toBe(0);

    await admin.query(
      'truncate trusted_browser, mfa_challenge, mfa_factor, setup_grant, session, staff_identity',
    );
    const stranded = await strandedDocument();
    stranded.document.audit.push({
      ...eventOf(stranded.document, 'auth.setup_grant.issued'),
      id: randomUUID(),
      event_code: 'auth.setup_grant.superseded',
      object_id: randomUUID(),
    });
    const smuggled = await refusalOf(() => resume(JSON.stringify(stranded.document)));
    expect(smuggled.code).toBe('22023');
    expect(
      Number(
        await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
          stranded.label,
        ]),
      ),
    ).toBe(0);
  });

  // Break caught: a resume that judges the conditions without holding the identity, so that a credential operation racing it (a
  // setup that consumes the secret, an enrolment that activates the factor) is read before it commits and changed after.
  it('takes the identity lock itself, whatever the read before it did: a holder of the row makes it wait', async () => {
    const { first } = await seededPair();
    await strandAfterEnrolment(first.id, first.grantId);
    const label = correlation();
    const plan = planFor(await stateOf(first.workEmailCanonical), label);
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from staff_identity where id = $1 for no key update', [
        first.id,
      ]);
      const refused = await refusalOf(() =>
        asProvisioning(async (client) => {
          await client.query("set lock_timeout = '300ms'");
          return client.query(RESUME, [plan.document]);
        }),
      );
      expect(refused.code).toBe('55P03');
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
    expect(
      Number(
        await scalar(admin, 'select count(*)::int from audit_event where correlation_id = $1', [
          label,
        ]),
      ),
    ).toBe(0);
    expect(
      Number(await scalar(admin, "select count(*)::int from mfa_factor where status = 'REVOKED'")),
    ).toBe(0);
  });

  it('refuses a document that is not an object', async () => {
    await seededPair();
    for (const text of ['[]', 'null', '1'])
      expect((await refusalOf(() => resume(text))).code, text).toBe('22023');
  });
});
