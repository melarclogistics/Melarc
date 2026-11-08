import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomUUIDv7 } from '../../src/platform/auth/crypto/uuid-v7.js';
import type { TransactionOptions } from '../../src/platform/database/database.service.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
} from './support/credentials.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { riderContext, systemContext, vendorContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * F02 of the audit of 22 October 2026 (migration 0027): `melarc.staff_reset_facts(uuid[])`, the one way a staff read learns the second-
 * factor facts of identities, as the API's login (`melarc_api_runtime`). The factor, the grant and the delivery job are rows that only the
 * `authentication` capability reads; a staff context reaches **the facts and nothing else of them**, for **the identities its own
 * scope shows it**, in the one snapshot of a `REPEATABLE READ` transaction, judged at one instant.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const RR: TransactionOptions = { isolation: 'REPEATABLE READ' };

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  built = buildService(database, { poolMax: 2 });
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const privileged = (overrides: Partial<StaffRow> = {}) =>
  insertStaff(admin, staffRow({ roleBundleId: BUNDLE_IDS.seniorOps, ...overrides }));

const reading = (
  scope: { mode: 'SET' | 'ALL'; hubs?: readonly string[] },
  key: string | null = 'staff.read',
): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  surface: 'OPS_PORTAL',
  correlationId: 'staff-reset-facts-test',
  hubScopeMode: scope.mode,
  authorizedHubIds: scope.hubs ?? [],
  ...(key === null ? {} : { authorizationKey: key }),
});

interface FactsRow {
  readonly identity_id: string;
  readonly status: string;
  readonly origin: string;
  readonly privileged: boolean;
  readonly has_credential: boolean;
  readonly has_active_factor: boolean;
  readonly has_pending_factor: boolean;
  readonly has_usable_grant: boolean;
  readonly has_pending_delivery: boolean;
  readonly latest_status: string | null;
  readonly latest_revoked_by_admin: boolean | null;
  readonly latest_has_episode: boolean | null;
}

const list = (ids: readonly string[]): string => `{${ids.join(',')}}`;

const factsFor = (
  context: SecurityContext,
  ids: readonly string[],
  options?: TransactionOptions,
): Promise<FactsRow[]> =>
  built.service.transactionWithContext(
    context,
    async (tx) =>
      (await tx.execute(sql`select * from melarc.staff_reset_facts(${list(ids)}::uuid[])`))
        .rows as unknown as FactsRow[],
    options,
  );

/** The SQLSTATE the server refused a statement with, or `undefined` if it did not refuse. */
async function refusedWith(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
}

const factorId = (): string => randomUUIDv7({ now: () => new Date() });

async function withActiveFactor(row: StaffRow): Promise<void> {
  const factor = await insertFactor(admin, factorRow(row.id, { id: factorId() }));
  await activateFactor(admin, factor.id);
}

describe('whose facts a staff context is given', () => {
  // Break caught: the function answering for any identity it is named, so that a holder of staff.read in one hub learns the factor
  // posture of the staff of another. The scope is the caller's own, read by the function under the caller's context.
  it('answers for the identities the context’s own scope shows it, and for no other, even when it names them', async () => {
    const inA = await privileged({ primaryHubId: HUB_A });
    const inB = await privileged({ primaryHubId: HUB_B });
    const hubless = await privileged({ primaryHubId: null });
    const named = [inA.id, inB.id, hubless.id];

    const own = await factsFor(reading({ mode: 'SET', hubs: [HUB_A] }), named, RR);
    const all = await factsFor(reading({ mode: 'ALL' }), named, RR);
    const none = await factsFor(reading({ mode: 'SET', hubs: [] }), named, RR);

    expect(own.map((row) => row.identity_id)).toEqual([inA.id]);
    expect(all.map((row) => row.identity_id).toSorted()).toEqual(named.toSorted());
    expect(none).toEqual([]);
  });

  // Break caught: an identifier that matches nothing answered as though the identity existed with no factor.
  it('says nothing of an identifier that matches no identity', async () => {
    expect(await factsFor(reading({ mode: 'ALL' }), [randomUUID()], RR)).toEqual([]);
  });

  // Break caught: the facts of an identity read wrongly, a grant that is judged by the application's clock, or the rule's inputs lost.
  it('answers the facts the rule reads, for each recorded history', async () => {
    const proven = await privileged({ primaryHubId: HUB_A });
    await withActiveFactor(proven);
    const stranded = await privileged({ primaryHubId: HUB_A });
    await insertFactor(admin, factorRow(stranded.id, { id: factorId() }));
    await insertGrant(admin, grantRow({ principalId: stranded.id, purpose: 'MFA_ENROLMENT' }));
    const ordinary = await insertStaff(
      admin,
      staffRow({ roleBundleId: BUNDLE_IDS.opsStaff, primaryHubId: HUB_A }),
    );

    const answer = await factsFor(
      reading({ mode: 'SET', hubs: [HUB_A] }),
      [proven.id, stranded.id, ordinary.id],
      RR,
    );
    const byId = new Map(answer.map((row) => [row.identity_id, row]));

    expect(byId.get(proven.id)).toMatchObject({
      status: 'ACTIVE',
      origin: 'MAKER_CHECKER',
      privileged: true,
      has_credential: true,
      has_active_factor: true,
      has_pending_factor: false,
      has_usable_grant: false,
      has_pending_delivery: false,
      latest_status: 'ACTIVE',
    });
    expect(byId.get(stranded.id)).toMatchObject({
      has_active_factor: false,
      has_pending_factor: true,
      has_usable_grant: true,
      latest_status: 'PENDING',
    });
    expect(byId.get(ordinary.id)).toMatchObject({ privileged: false, has_active_factor: false });
  });

  // Break caught: a grant that has passed its time still counted as usable, or one that has not counted as lapsed: it is the
  // database's clock at the one instant of the call, with nothing written between the two reads.
  it('judges a grant on the database clock: usable before its time, not after, with no row written', async () => {
    const row = await privileged({ primaryHubId: HUB_A });
    await insertFactor(admin, factorRow(row.id, { id: factorId() }));
    const grant = await insertGrant(
      admin,
      grantRow({
        principalId: row.id,
        purpose: 'MFA_ENROLMENT',
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 4_000),
      }),
    );
    const context = reading({ mode: 'SET', hubs: [HUB_A] });

    const before = (await factsFor(context, [row.id], RR))[0];
    await admin.query(
      `select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp())) + 0.2)) from setup_grant where id = $1`,
      [grant.id],
    );
    const after = (await factsFor(context, [row.id], RR))[0];

    expect([before?.has_usable_grant, after?.has_usable_grant]).toEqual([true, false]);
  });
});

describe('what a staff context gains from the function, and what it does not', () => {
  // Break caught: the function leaving the caller in the authentication capability: the rest of the transaction would read a
  // factor, a grant or a delivery job, and the whole table of identities. The caller's own context comes back, and with it its scope.
  it('gives the caller’s own context back: no factor row, no grant, and the scope of the context, after the call', async () => {
    const inA = await privileged({ primaryHubId: HUB_A });
    const inB = await privileged({ primaryHubId: HUB_B });
    await withActiveFactor(inA);

    const after = await built.service.transactionWithContext(
      reading({ mode: 'SET', hubs: [HUB_A] }),
      async (tx) => {
        const facts = (
          await tx.execute(
            sql`select * from melarc.staff_reset_facts(${list([inA.id, inB.id])}::uuid[])`,
          )
        ).rows;
        const rest = await tx.execute(sql`
          select current_setting('melarc.principal_type', true) as principal_type,
                 current_setting('melarc.task_capability', true) as task_capability,
                 (select count(*) from mfa_factor)::int as factors,
                 (select count(*) from setup_grant)::int as grants,
                 (select count(*) from credential_delivery_job)::int as jobs,
                 (select array_agg(id) from staff_identity where id = any(${list([inA.id, inB.id])}::uuid[])) as visible`);
        return { facts, rest: rest.rows[0] ?? {} };
      },
      RR,
    );

    expect(after.facts).toHaveLength(1);
    expect(after.rest).toMatchObject({
      principal_type: 'STAFF',
      factors: 0,
      grants: 0,
      jobs: 0,
      visible: [inA.id],
    });
    expect([null, '']).toContain(after.rest.task_capability);
  });

  // Break caught: a column added to the answer that is not a fact (a hash, a secret, an identifier of a grant or of a job, a counter): a
  // staff caller must never be handed what only the authentication capability reads.
  it('answers exactly the facts, and no secret, hash, token, counter or record identifier', async () => {
    const answer = await built.service.transactionWithContext(
      reading({ mode: 'ALL' }),
      async (tx) =>
        await tx
          .execute(sql`select * from melarc.staff_reset_facts('{}'::uuid[])`)
          .then((result) => result.fields.map((field) => field.name)),
      RR,
    );

    expect(answer).toEqual([
      'identity_id',
      'status',
      'origin',
      'privileged',
      'has_credential',
      'has_active_factor',
      'has_pending_factor',
      'has_usable_grant',
      'has_pending_delivery',
      'latest_status',
      'latest_revoked_by_admin',
      'latest_has_episode',
    ]);
  });

  // Break caught: the function open to another login (the worker, the provisioning login) or to PUBLIC, or running as its caller so
  // that the capability switch is refused, or without a fixed search path.
  it('is executable by the API’s login alone, owned by the owner role, definer, with a fixed search path', async () => {
    const posture = await admin.query<{
      api: boolean;
      worker: boolean;
      provisioning: boolean;
      public_execute: boolean;
      definer: boolean;
      owner: string;
      config: string[] | null;
    }>(
      `select has_function_privilege('melarc_api_runtime', p.oid, 'execute') as api,
              has_function_privilege('melarc_worker_runtime', p.oid, 'execute') as worker,
              has_function_privilege('melarc_provisioning', p.oid, 'execute') as provisioning,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_execute,
              p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'melarc' and p.proname = 'staff_reset_facts'`,
    );

    expect(posture.rows).toHaveLength(1);
    expect(posture.rows[0]).toMatchObject({
      api: true,
      worker: false,
      provisioning: false,
      public_execute: false,
      definer: true,
      owner: 'melarc_owner',
    });
    expect(posture.rows[0]?.config).toContain('search_path=pg_catalog, pg_temp');
  });
});

describe('who may ask', () => {
  // Break caught: the function open to a staff context that does not hold the key of the read: a Senior Ops user's session for any
  // other operation would reach the facts.
  it.each([
    ['another key', 'permission.assignable_bundle.read'],
    ['no key', null],
  ] as const)('refuses a staff context holding %s (42501)', async (_name, key) => {
    const row = await privileged({ primaryHubId: HUB_A });

    const state = await refusedWith(() => factsFor(reading({ mode: 'ALL' }, key), [row.id], RR));

    expect(state).toBe('42501');
  });

  // Break caught: a Vendor, a Rider or a technical capability other than authentication reaching the facts.
  it.each([
    ['a Vendor', () => vendorContext(randomUUID())],
    ['a Rider', () => riderContext(randomUUID())],
    ['the rate-limit capability', () => systemContext('rate_limit')],
  ] as const)('refuses %s (42501)', async (_name, context) => {
    const row = await privileged({ primaryHubId: HUB_A });

    const state = await refusedWith(() => factsFor(context(), [row.id], RR));

    expect(state).toBe('42501');
  });

  // Break caught: the facts read in separate pictures: at READ COMMITTED each statement of the call would see what was committed when it
  // began, and the answer for a page of identities would not be one state of them. A staff caller is refused unless the transaction
  // is one snapshot.
  it('refuses a staff context that is not in one snapshot (25000)', async () => {
    const row = await privileged({ primaryHubId: HUB_A });
    const context = reading({ mode: 'SET', hubs: [HUB_A] });

    const state = await refusedWith(() => factsFor(context, [row.id]));
    const accepted = await factsFor(context, [row.id], RR);

    expect(state).toBe('25000');
    expect(accepted).toHaveLength(1);
  });

  // Break caught: the authentication capability (which the reset operation runs under) refused, or limited to a scope it does not have.
  it('answers the authentication capability for every identity named, at either isolation', async () => {
    const inA = await privileged({ primaryHubId: HUB_A });
    const inB = await privileged({ primaryHubId: HUB_B });

    const committed = await factsFor(systemContext('authentication'), [inA.id, inB.id]);
    const snapshot = await factsFor(systemContext('authentication'), [inA.id, inB.id], RR);

    expect(committed.map((row) => row.identity_id).toSorted()).toEqual([inA.id, inB.id].toSorted());
    expect(snapshot).toHaveLength(2);
  });

  // Break caught: a page that is not a bounded one, or no list at all, answered. The list reads at most 100 identities.
  it.each([
    ['more than 100 identifiers', Array.from({ length: 101 }, () => randomUUID())],
  ] as const)('refuses %s (22023)', async (_name, ids) => {
    const state = await refusedWith(() => factsFor(reading({ mode: 'ALL' }), ids, RR));

    expect(state).toBe('22023');
  });

  it('refuses no list at all (22023)', async () => {
    const state = await refusedWith(() =>
      built.service.transactionWithContext(
        reading({ mode: 'ALL' }),
        (tx) => tx.execute(sql`select * from melarc.staff_reset_facts(null::uuid[])`),
        RR,
      ),
    );

    expect(state).toBe('22023');
  });
});

describe('one picture', () => {
  // Break caught (F02): the identity read in one picture and its facts in another: a status moved or a factor proven between the two
  // reads, so that the representation says a state of the record that never existed. The facts are those of the snapshot the transaction
  // fixed at its start, whatever another connection commits meanwhile; the next transaction sees the change.
  it('answers from the snapshot of the transaction, not from what another connection commits after it began', async () => {
    const row = await privileged({ primaryHubId: HUB_A });
    const context = reading({ mode: 'SET', hubs: [HUB_A] });

    const seen = await built.service.transactionWithContext(
      context,
      async (tx) => {
        const read = await tx.execute(
          sql`select status from staff_identity where id = ${row.id}::uuid`,
        );
        await admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [row.id]);
        await withActiveFactor(row);
        const facts = await tx.execute(
          sql`select * from melarc.staff_reset_facts(${list([row.id])}::uuid[])`,
        );
        return { read: read.rows[0], facts: facts.rows[0] };
      },
      RR,
    );
    const later = await factsFor(context, [row.id], RR);

    expect(seen.read).toMatchObject({ status: 'ACTIVE' });
    expect(seen.facts).toMatchObject({ status: 'ACTIVE', has_active_factor: false });
    expect(later[0]).toMatchObject({ status: 'SUSPENDED', has_active_factor: true });
  });
});

describe('one instant', () => {
  // The instant is read once, at the start of the call, and every fact of every identity that is judged by time uses it: two
  // identities cannot be judged at two moments of one page. A behavioural proof would need a clock the test controls, so this holds
  // the structure: one reading of the clock in the function, and none inside its queries.
  it('reads the clock once for the whole call', async () => {
    const source = await admin.query<{ prosrc: string }>(
      `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'melarc' and p.proname = 'staff_reset_facts'`,
    );

    const body = source.rows[0]?.prosrc ?? '';

    expect(body.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(body).toContain('evaluated_at');
  });
});
