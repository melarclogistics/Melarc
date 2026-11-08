import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createScopeProbe } from '../../src/platform/database/scope-probe.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.35 (migration 0024): who reads which staff identity, and the version a read carries, against a real PostgreSQL, as the API's login
 * (`melarc_api_runtime`). The reads of `staff.read` are row-level security and nothing else (`AC-SLICE-000-30`): a staff context that
 * holds the key reaches the identities of its hubs, or all of them under the explicit all-hub scope, and the scope probe, which names a
 * record and reads one column of it, is the only way to learn that a record outside the scope exists. The version is the ETag of the
 * record (domain-model.md §6.8): it moves with what a read returns and never with a failed attempt.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const PROBE = createScopeProbe({
  staff_identity: { schema: 'public', table: 'staff_identity', hubColumn: 'primary_hub_id' },
});

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;
let actorA: StaffRow;
let inA: StaffRow;
let inB: StaffRow;
let hubless: StaffRow;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  actorA = await insertStaff(admin, staffRow({ primaryHubId: HUB_A }));
  inA = await insertStaff(admin, staffRow({ primaryHubId: HUB_A }));
  inB = await insertStaff(admin, staffRow({ primaryHubId: HUB_B }));
  hubless = await insertStaff(admin, staffRow({ primaryHubId: null }));
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const reading = (
  principalId: string,
  scope: { mode: 'SET' | 'ALL'; hubs?: readonly string[] },
  key: string | null = 'staff.read',
): SecurityContext => ({
  principalType: 'STAFF',
  principalId,
  surface: 'OPS_PORTAL',
  correlationId: 'staff-identity-reads-test',
  hubScopeMode: scope.mode,
  authorizedHubIds: scope.hubs ?? [],
  ...(key === null ? {} : { authorizationKey: key }),
});

const ours = (): string[] => [actorA.id, inA.id, inB.id, hubless.id];

/** The ids of the four identities of this file that a context can read, by a query that names no hub. */
async function visibleTo(context: SecurityContext): Promise<string[]> {
  return built.service.transactionWithContext(context, async (tx) => {
    const result = await tx.execute(
      sql`select id from staff_identity where id = any(${`{${ours().join(',')}}`}::uuid[]) order by id`,
    );
    return (result.rows as { id: string }[]).map((row) => row.id);
  });
}
const sorted = (...rows: readonly StaffRow[]): string[] => rows.map((row) => row.id).toSorted();

describe('who reads a staff identity (AC-SLICE-000-30, AC-SLICE-000-07)', () => {
  // Break caught: a hub-scoped read that does not apply to the identities of other hubs, so that a Senior Ops user lists the staff of
  // a hub they do not act in; or the actor's own row lost from a list the actor holds the key for.
  it('shows a holder of staff.read in a set of hubs the identities of those hubs, its own among them, and no other', async () => {
    const seen = await visibleTo(reading(actorA.id, { mode: 'SET', hubs: [HUB_A] }));

    expect(seen).toEqual(sorted(actorA, inA));
  });

  // Break caught: the all-hub scope not reaching an identity with no primary hub (the two bootstrap administrators hold none), or an
  // `ALL` that stays a set of one.
  it('shows the explicit all-hub scope every identity, the one with no primary hub among them', async () => {
    const seen = await visibleTo(reading(actorA.id, { mode: 'ALL' }));

    expect(seen).toEqual(sorted(actorA, inA, inB, hubless));
  });

  // Break caught: an empty set of hubs read as all of them (`GBT-B5`): an empty set means no hub-scoped rows, so the actor's own row
  // is all there is.
  it('shows an empty set of hubs no hub-scoped row but the actor’s own', async () => {
    expect(await visibleTo(reading(actorA.id, { mode: 'SET', hubs: [] }))).toEqual([actorA.id]);
  });

  // Break caught: the hub reach of staff.read granted to a context that holds another key (or none): the policy is the key's. A
  // permission-less context reads its own row, as authentication needs, and nothing else.
  it.each([
    ['another key', 'permission.assignable_bundle.read'],
    ['no key', null],
  ] as const)(
    'shows a context holding %s only its own row, whatever its hubs',
    async (_name, key) => {
      expect(await visibleTo(reading(actorA.id, { mode: 'ALL' }, key))).toEqual([actorA.id]);
      expect(
        await visibleTo(reading(actorA.id, { mode: 'SET', hubs: [HUB_A, HUB_B] }, key)),
      ).toEqual([actorA.id]);
    },
  );

  // Break caught (AC-SLICE-000-30: "a deliberately unfiltered query in a test returns only the session's hubs"): the restriction
  // living in the use case's own WHERE and not in the database. The actor's own row is the one other row it may read.
  it('restricts a query that names no hub at all to the hubs of the session', async () => {
    const result = await built.service.transactionWithContext(
      reading(actorA.id, { mode: 'SET', hubs: [HUB_B] }),
      async (tx) =>
        (await tx.execute(sql`select id, primary_hub_id from staff_identity`)).rows as {
          id: string;
          primary_hub_id: string | null;
        }[],
    );

    const others = result.filter((row) => row.id !== actorA.id);
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((row) => row.primary_hub_id !== HUB_B)).toEqual([]);
  });

  // Break caught: a vendor, a rider or a SYSTEM context under another capability reading the staff table.
  it('shows a vendor, a rider and a SYSTEM context under another capability no identity', async () => {
    const contexts: SecurityContext[] = [
      {
        principalType: 'VENDOR',
        principalId: randomUUID(),
        surface: 'VENDOR_PWA',
        vendorOrganizationId: randomUUID(),
        correlationId: 'staff-identity-reads-test',
      },
      {
        principalType: 'RIDER',
        principalId: randomUUID(),
        surface: 'RIDER_ANDROID',
        riderId: randomUUID(),
        correlationId: 'staff-identity-reads-test',
      },
      {
        principalType: 'SYSTEM',
        principalId: randomUUID(),
        surface: 'SYSTEM',
        taskCapability: 'rate_limit',
        correlationId: 'staff-identity-reads-test',
      },
    ];
    for (const context of contexts) expect(await visibleTo(context)).toEqual([]);
  });
});

describe('the scope probe on a staff identity (AC-SLICE-000-30)', () => {
  const probeAs = (context: SecurityContext, id: string) =>
    built.service.transactionWithContext(context, (tx) => PROBE(tx, 'staff_identity', id));

  // Break caught: the probe unable to say where an existing record outside the scope is, which is the whole of HUB_SCOPE_VIOLATION.
  it('names the hub of an existing identity outside the actor’s hubs, and only the hub', async () => {
    const context = reading(actorA.id, { mode: 'SET', hubs: [HUB_A] });

    expect(await probeAs(context, inB.id)).toBe(HUB_B);
    // The probe read one row for one statement: the record stays unreachable to the next.
    expect(await visibleTo(context)).toEqual(sorted(actorA, inA));
  });

  // Break caught: a record with no hub, or none at all, answering a hub: both are "nothing found".
  it('answers nothing for an identity with no primary hub and for an identifier that matches nothing', async () => {
    const context = reading(actorA.id, { mode: 'SET', hubs: [HUB_A] });

    expect(await probeAs(context, hubless.id)).toBeUndefined();
    expect(await probeAs(context, randomUUID())).toBeUndefined();
  });

  // Break caught: the probe answering a principal that is not staff, who must be told what a missing record gets.
  it('answers nothing to a vendor, a rider and a SYSTEM context', async () => {
    const contexts: SecurityContext[] = [
      {
        principalType: 'VENDOR',
        principalId: randomUUID(),
        surface: 'VENDOR_PWA',
        vendorOrganizationId: randomUUID(),
        correlationId: 'staff-identity-reads-test',
      },
      {
        principalType: 'RIDER',
        principalId: randomUUID(),
        surface: 'RIDER_ANDROID',
        riderId: randomUUID(),
        correlationId: 'staff-identity-reads-test',
      },
      {
        principalType: 'SYSTEM',
        principalId: randomUUID(),
        surface: 'SYSTEM',
        taskCapability: 'authentication',
        correlationId: 'staff-identity-reads-test',
      },
    ];
    for (const context of contexts) expect(await probeAs(context, inB.id)).toBeUndefined();
  });
});

describe('what a read of staff identities cannot do', () => {
  const refusal = async (work: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await work();
      return undefined;
    } catch (error) {
      return serverErrorIn(error)?.code;
    }
  };

  // Break caught: the read policy becoming a way to change a record (the policies are for SELECT, and the grant is of three columns).
  it('changes nothing: the runtime updates no returned column and inserts and deletes nothing', async () => {
    const context = reading(actorA.id, { mode: 'ALL' });
    const attempt = (statement: ReturnType<typeof sql>) => () =>
      built.service.transactionWithContext(context, (tx) => tx.execute(statement));

    expect(
      await refusal(
        attempt(sql`update staff_identity set full_name = 'Changed' where id = ${inA.id}`),
      ),
    ).toBe('42501');
    expect(
      await refusal(attempt(sql`update staff_identity set version = 99 where id = ${inA.id}`)),
    ).toBe('42501');
    expect(await refusal(attempt(sql`delete from staff_identity where id = ${inA.id}`))).toBe(
      '42501',
    );
    expect(
      (await admin.query('select full_name from staff_identity where id = $1', [inA.id])).rows[0],
    ).toEqual({ full_name: 'Ama Mensah' });
  });

  // Break caught: the new columns widening what the runtime may read: the credential stays unreadable, and the two new columns can be read.
  it('reads `phone` and `version` and still reads no credential', async () => {
    const context = reading(actorA.id, { mode: 'ALL' });

    const read = await built.service.transactionWithContext(context, async (tx) => {
      const result = await tx.execute(
        sql`select phone, version from staff_identity where id = ${inA.id}`,
      );
      return result.rows[0];
    });
    const credential = await refusal(() =>
      built.service.transactionWithContext(context, (tx) =>
        tx.execute(sql`select credential_hash from staff_identity where id = ${inA.id}`),
      ),
    );

    expect(read).toEqual({ phone: null, version: 1 });
    expect(credential).toBe('42501');
  });
});

describe('the version of a staff identity, which is its ETag (domain-model.md §6.8)', () => {
  const versionOf = async (id: string): Promise<number> =>
    (
      (await admin.query('select version from staff_identity where id = $1', [id])).rows[0] as {
        version: number;
      }
    ).version;
  /** Applies one change as the administrator and says how far the version moved. */
  async function moved(row: StaffRow, change: string, values: unknown[] = []): Promise<number> {
    const before = await versionOf(row.id);
    await admin.query(`update staff_identity set ${change} where id = $1`, [row.id, ...values]);
    return (await versionOf(row.id)) - before;
  }

  // Break caught: a version that stays still when a returned field changes, so that an `If-Match` taken from a read still matches a
  // record that has since changed.
  it.each([
    ['the name', "full_name = 'Kofi Boateng'"],
    ['the status', "status = 'SUSPENDED'"],
    ['the phone', "phone = '+233200000000'"],
    ['the primary hub', `primary_hub_id = '${HUB_B}'`],
    [
      'the work email',
      "work_email = 'new-address@example.test', work_email_canonical = 'new-address@example.test'",
    ],
    ['the role bundle', `role_bundle_id = '${BUNDLE_IDS.seniorOps}'`],
  ])('moves by one when %s changes', async (_name, change) => {
    const row = await insertStaff(admin, staffRow({ primaryHubId: HUB_A }));

    expect(await moved(row, change)).toBe(1);
  });

  // Break caught: the credential established or changed not moving the version (a re-issue or a recovery changes what the read says
  // about the credential), or a rehash at a new cost moving it (nobody changed anything).
  it('moves when the credential is established or replaced, and does not move when it is rehashed', async () => {
    const row = await insertStaff(admin, staffRow({ primaryHubId: HUB_A }));

    expect(
      await moved(
        row,
        `credential_generation = credential_generation + 1, credential_established_at = now(), credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$bmV3'`,
      ),
    ).toBe(1);
    expect(
      await moved(row, `credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$cmVoYXNo'`),
    ).toBe(0);
  });

  // Break caught (domain-model.md §6.8: "not a failed attempt"): a failed sign-in moving the version, which would make every wrong
  // password invalidate the `If-Match` of the person reading the record.
  it('does not move for a failed attempt, a lock, or an update that changes nothing', async () => {
    const row = await insertStaff(admin, staffRow({ primaryHubId: HUB_A }));

    expect(await moved(row, 'failed_attempt_count = failed_attempt_count + 1')).toBe(0);
    expect(await moved(row, "locked_until = now() + interval '15 minutes'")).toBe(0);
    expect(await moved(row, 'locked_until = null, failed_attempt_count = 0')).toBe(0);
    expect(await moved(row, 'full_name = full_name')).toBe(0);
  });

  // Break caught: a writer setting the version itself, which would let any update choose the ETag it leaves.
  it('is set by the database alone: an update that names the version gets the next one, or the same', async () => {
    const row = await insertStaff(admin, staffRow({ primaryHubId: HUB_A }));

    expect(await moved(row, 'version = 500')).toBe(0);
    expect(await moved(row, "version = 500, full_name = 'Yaw Owusu'")).toBe(1);
  });
});
