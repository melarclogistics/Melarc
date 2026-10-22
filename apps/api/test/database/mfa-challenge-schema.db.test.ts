import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MFA_CHALLENGE_STATES } from '../../src/staff/mfa-challenge.schema.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { challengeRow, insertChallenge, type ChallengeRow } from './support/credentials.js';
import { withHandle } from './support/handle.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { staffContext, systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.32, the MFA challenge (migration 0020, `mfa_challenge`) and the lockout columns of `staff_identity`, against a real PostgreSQL:
 * what the schema itself refuses (tried as the administrator, who is held to the table's checks, foreign key and guard triggers), and
 * what the API's login may do under each context (row-level security and the column grants). The behaviour (the sign-in that issues
 * a challenge and the second step that spends it) is the operations' own tests.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 2 });
});

afterAll(async () => {
  await admin.end();
  await api.close();
  await database.drop();
});

interface Refusal {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
  /** The machine-readable reason of a refusal that states one (`reason=...`), which no check or other guard rule does. */
  readonly detail: string | undefined;
}

/** What the database said to a statement, or `undefined` when it ran. */
async function refusalOf(statement: string, values: unknown[] = []): Promise<Refusal | undefined> {
  try {
    await admin.query(statement, values);
    return undefined;
  } catch (error) {
    const { code, constraint, message, detail } = error as {
      code?: string;
      constraint?: string;
      message?: string;
      detail?: string;
    };
    return { code, constraint, message: message ?? '', detail };
  }
}

const identity = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const challengeOf = (
  owner: StaffRow,
  overrides: Partial<ChallengeRow> = {},
): Promise<ChallengeRow> => insertChallenge(admin, challengeRow(owner.id, overrides));
const refusalOfInsert = async (row: ChallengeRow): Promise<Refusal | undefined> => {
  try {
    await insertChallenge(admin, row);
    return undefined;
  } catch (error) {
    const { code, constraint, message, detail } = error as {
      code?: string;
      constraint?: string;
      message?: string;
      detail?: string;
    };
    return { code, constraint, message: message ?? '', detail };
  }
};
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

const stateOf = async (id: string): Promise<{ state: string; attempt_count: number }> =>
  (
    await admin.query<{ state: string; attempt_count: number }>(
      'select state, attempt_count from mfa_challenge where id = $1',
      [id],
    )
  ).rows[0] ?? { state: 'GONE', attempt_count: -1 };

describe('the table repeats the closed set of the code, and a change to one fails here', () => {
  it('holds the four states of MFA_CHALLENGE_STATES', async () => {
    const definition = (
      await admin.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
          where conname = 'mfa_challenge_state_closed' and conrelid = 'public.mfa_challenge'::regclass`,
      )
    ).rows[0]?.definition;
    const words = [
      ...new Set((definition?.match(/'[A-Za-z_]+'/g) ?? []).map((w) => w.slice(1, -1))),
    ];

    expect(words.toSorted()).toEqual([...MFA_CHALLENGE_STATES].toSorted());
  });
});

describe('a challenge is held to the rules of the domain model', () => {
  // Break caught (§6.8): a challenge with no lifetime, one that lives before it is issued, a state outside the four, a negative count.
  it('needs a lifetime that begins after the issue, one of the four states and a count that is not negative', async () => {
    const owner = await identity();
    const now = new Date();

    expect(
      (await refusalOfInsert(challengeRow(owner.id, { issuedAt: now, expiresAt: now })))
        ?.constraint,
    ).toBe('mfa_challenge_expiry_after_issue');
    expect(
      (await refusalOfInsert(challengeRow(owner.id, { issuedAt: now, expiresAt: minutesAgo(1) })))
        ?.constraint,
    ).toBe('mfa_challenge_expiry_after_issue');
    const row = await challengeOf(owner);
    expect(
      (await refusalOf(`update mfa_challenge set state = 'LOST' where id = $1`, [row.id]))
        ?.constraint,
    ).toBe('mfa_challenge_state_closed');
    // The guard answers before the check, and either way a count below zero is refused.
    expect(
      await refusalOf(`update mfa_challenge set attempt_count = -1 where id = $1`, [row.id]),
    ).toBeDefined();
  });

  // Break caught: a challenge issued on a credential that is not there (generation zero), or on one that is not the identity's current
  // one: a session would then be issued on the strength of a credential that was already replaced.
  it('is issued on the credential its identity holds now: a generation of one or more, and the identity’s own', async () => {
    const owner = await identity();

    // The insert guard answers before the table's check, and either way a challenge on no credential, or on another one, is refused.
    expect(
      await refusalOfInsert(challengeRow(owner.id, { credentialGeneration: 0 })),
    ).toBeDefined();
    expect(
      (await refusalOfInsert(challengeRow(owner.id, { credentialGeneration: 2 })))?.message,
    ).toMatch(/issued on the credential its identity holds now/);
    await challengeOf(owner, { credentialGeneration: 1 });
  });

  it('belongs to an identity that exists, and keeps it: no identity is removed under its challenges', async () => {
    const owner = await identity();
    await challengeOf(owner);

    expect((await refusalOfInsert(challengeRow(randomUUID())))?.message).toMatch(
      /issued on the credential its identity holds now/,
    );
    expect(
      (await refusalOf('delete from staff_identity where id = $1', [owner.id]))?.constraint,
    ).toBe('mfa_challenge_identity_fkey');
  });

  it('is issued PENDING with no wrong code, whoever inserts it', async () => {
    const owner = await identity();
    const id = randomUUID();

    for (const [state, count] of [
      ['CONSUMED', 0],
      ['PENDING', 1],
    ] as const) {
      const refused = await refusalOf(
        `insert into mfa_challenge (id, staff_identity_id, credential_generation, issued_at, expires_at, state, attempt_count)
         values ($1, $2, 1, now() - interval '1 minute', now() + interval '4 minutes', $3, $4)`,
        [id, owner.id, state, count],
      );
      expect(refused?.message, `${state}/${String(count)}`).toMatch(
        /issued PENDING and with no wrong code/,
      );
    }
  });
});

describe('the update guard keeps a challenge to its state machine', () => {
  // Break caught: the identity, the credential or the lifetime of a challenge rewritten after it was issued (a challenge lengthened, or
  // moved to another identity).
  it('keeps everything but its state and its count of wrong codes', async () => {
    const owner = await identity();
    const other = await identity();
    const row = await challengeOf(owner);
    const statements: [string, unknown[]][] = [
      [
        "update mfa_challenge set expires_at = expires_at + interval '1 hour' where id = $1",
        [row.id],
      ],
      [
        "update mfa_challenge set issued_at = issued_at - interval '1 hour' where id = $1",
        [row.id],
      ],
      ['update mfa_challenge set staff_identity_id = $2 where id = $1', [row.id, other.id]],
      ['update mfa_challenge set credential_generation = 2 where id = $1', [row.id]],
      ['update mfa_challenge set id = gen_random_uuid() where id = $1', [row.id]],
    ];

    for (const [statement, values] of statements) {
      expect((await refusalOf(statement, values))?.message, statement).toMatch(
        /keeps everything but its state and its count/,
      );
    }
  });

  // Break caught (§6.8: "EXPIRED and UNUSABLE are different terminal states"): a terminal challenge brought back, or changed.
  it('lets only a PENDING challenge change: the three other states are terminal', async () => {
    const owner = await identity();
    const consumed = await challengeOf(owner);
    await admin.query(`update mfa_challenge set state = 'CONSUMED' where id = $1`, [consumed.id]);
    const unusable = await challengeOf(owner);
    await admin.query(
      `update mfa_challenge set state = 'UNUSABLE', attempt_count = 1 where id = $1`,
      [unusable.id],
    );
    const expired = await challengeOf(owner, {
      issuedAt: minutesAgo(10),
      expiresAt: minutesAgo(5),
    });
    await admin.query(`update mfa_challenge set state = 'EXPIRED' where id = $1`, [expired.id]);

    for (const row of [consumed, unusable, expired]) {
      for (const change of [
        `state = 'PENDING'`,
        ...(row === consumed ? [] : [`state = 'CONSUMED'`]),
        `attempt_count = attempt_count + 1`,
      ]) {
        expect(
          (await refusalOf(`update mfa_challenge set ${change} where id = $1`, [row.id]))?.message,
          `${row.id} ${change}`,
        ).toMatch(/only a PENDING challenge changes/);
      }
    }
  });

  // Break caught: a count of wrong codes that jumps (so that a challenge reaches "unusable" in fewer wrong codes than the setting says)
  // or falls (a wrong code forgiven).
  it('raises the count of wrong codes by one at a time and never lowers it', async () => {
    const owner = await identity();
    const row = await challengeOf(owner);

    expect(
      (await refusalOf('update mfa_challenge set attempt_count = 2 where id = $1', [row.id]))
        ?.message,
    ).toMatch(/rises by one and never falls/);
    await admin.query('update mfa_challenge set attempt_count = 1 where id = $1', [row.id]);
    await admin.query('update mfa_challenge set attempt_count = 2 where id = $1', [row.id]);
    expect(
      (await refusalOf('update mfa_challenge set attempt_count = 1 where id = $1', [row.id]))
        ?.message,
    ).toMatch(/rises by one and never falls/);
    expect(await stateOf(row.id)).toEqual({ state: 'PENDING', attempt_count: 2 });
  });

  // Break caught: a challenge marked expired while it still has time (a live sign-in ended early), or consumed after its time (a code
  // accepted on an expired challenge).
  it('expires only once its time has passed, and is consumed only before it', async () => {
    const owner = await identity();
    const live = await challengeOf(owner);
    const lapsed = await challengeOf(owner, { issuedAt: minutesAgo(10), expiresAt: minutesAgo(5) });

    expect(
      (await refusalOf(`update mfa_challenge set state = 'EXPIRED' where id = $1`, [live.id]))
        ?.message,
    ).toMatch(/expires only when its time has passed/);
    const late = await refusalOf(`update mfa_challenge set state = 'CONSUMED' where id = $1`, [
      lapsed.id,
    ]);
    expect(late?.message).toMatch(/consumed only while it has not expired/);
    // A consumption that lost a race with the clock says so in a form the application can tell from every other refusal of the table
    // (the audit of 21 October 2026, A06); the early expiry above, and every other guard rule, state no reason.
    expect(late?.detail).toBe('reason=CHALLENGE_EXPIRED');
    expect(
      (await refusalOf(`update mfa_challenge set state = 'EXPIRED' where id = $1`, [live.id]))
        ?.detail,
    ).toBeUndefined();
    await admin.query(`update mfa_challenge set state = 'CONSUMED' where id = $1`, [live.id]);
    await admin.query(`update mfa_challenge set state = 'EXPIRED' where id = $1`, [lapsed.id]);
    expect((await stateOf(live.id)).state).toBe('CONSUMED');
    expect((await stateOf(lapsed.id)).state).toBe('EXPIRED');
  });

  it('becomes unusable with the wrong code that exhausts it, in one statement', async () => {
    const owner = await identity();
    const row = await challengeOf(owner);
    await admin.query('update mfa_challenge set attempt_count = 1 where id = $1', [row.id]);
    await admin.query('update mfa_challenge set attempt_count = 2 where id = $1', [row.id]);

    await admin.query(
      `update mfa_challenge set attempt_count = 3, state = 'UNUSABLE' where id = $1`,
      [row.id],
    );

    expect(await stateOf(row.id)).toEqual({ state: 'UNUSABLE', attempt_count: 3 });
  });
});

describe('the API login reaches challenges under the authentication capability and nowhere else', () => {
  const as = <T>(
    context: SecurityContext,
    work: (tx: Parameters<Parameters<typeof withHandle>[2]>[1]) => Promise<T>,
  ): Promise<T> => withHandle(api.service, context, (_handle, tx) => work(tx));
  const failure = async (action: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await action();
      return undefined;
    } catch (error) {
      return serverErrorIn(error)?.code;
    }
  };

  it('holds SELECT and INSERT on the table and an UPDATE of the state and the count alone, and no DELETE', async () => {
    const privileges = async (column?: string): Promise<string[]> => {
      // A column holds SELECT, INSERT, UPDATE and REFERENCES; the table holds the rest.
      const kinds =
        column === undefined
          ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
          : ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
      const held: string[] = [];
      for (const kind of kinds) {
        const result = await admin.query<{ held: boolean }>(
          column === undefined
            ? `select has_table_privilege('melarc_api_runtime', 'public.mfa_challenge', $1) as held`
            : `select has_column_privilege('melarc_api_runtime', 'public.mfa_challenge', $2, $1) as held`,
          column === undefined ? [kind] : [kind, column],
        );
        if (result.rows[0]?.held === true) held.push(kind);
      }
      return held;
    };

    expect(await privileges()).toEqual(['SELECT', 'INSERT']);
    expect(await privileges('state')).toContain('UPDATE');
    expect(await privileges('attempt_count')).toContain('UPDATE');
    for (const column of [
      'id',
      'staff_identity_id',
      'credential_generation',
      'issued_at',
      'expires_at',
    ]) {
      expect(await privileges(column), column).not.toContain('UPDATE');
    }
  });

  it('inserts, reads and updates a challenge as the authentication capability, and the guards still apply', async () => {
    const owner = await identity();
    const id = randomUUID();
    await as(systemContext('authentication'), (tx) =>
      tx.execute(sql`insert into mfa_challenge (id, staff_identity_id, credential_generation, issued_at, expires_at)
        values (${id}::uuid, ${owner.id}::uuid, 1, clock_timestamp(), clock_timestamp() + interval '5 minutes')`),
    );

    const read = await as(systemContext('authentication'), (tx) =>
      tx.execute(sql`select state, attempt_count from mfa_challenge where id = ${id}::uuid`),
    );
    expect(read.rows[0]).toEqual({ state: 'PENDING', attempt_count: 0 });
    await as(systemContext('authentication'), (tx) =>
      tx.execute(
        sql`update mfa_challenge set attempt_count = attempt_count + 1 where id = ${id}::uuid`,
      ),
    );
    expect((await stateOf(id)).attempt_count).toBe(1);
    expect(
      await failure(() =>
        as(systemContext('authentication'), (tx) =>
          tx.execute(
            sql`update mfa_challenge set expires_at = expires_at + interval '1 day' where id = ${id}::uuid`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  // Break caught: a policy that lets another capability, or a human principal, read or write a challenge (a challenge is the half of a
  // sign-in that names which identity passed its password).
  it('shows no challenge to a staff member or to another capability the API holds, and lets none be written', async () => {
    const owner = await identity();
    const row = await challengeOf(owner);
    const contexts: [string, SecurityContext][] = [
      ['a staff member', staffContext([])],
      // The API's login opens no other capability than its own (the service refuses the context before the database is asked).
      ['the rate limit capability', systemContext('rate_limit')],
    ];

    for (const [name, context] of contexts) {
      const seen = await as(context, (tx) =>
        tx.execute(sql`select id from mfa_challenge where id = ${row.id}::uuid`),
      );
      expect(seen.rows, name).toEqual([]);
      expect(
        await failure(() =>
          as(context, (tx) =>
            tx.execute(sql`insert into mfa_challenge (id, staff_identity_id, credential_generation, issued_at, expires_at)
              values (gen_random_uuid(), ${owner.id}::uuid, 1, clock_timestamp(), clock_timestamp() + interval '5 minutes')`),
          ),
        ),
        name,
      ).toBeDefined();
      const updated = await as(context, (tx) =>
        tx.execute(
          sql`update mfa_challenge set attempt_count = attempt_count + 1 where id = ${row.id}::uuid`,
        ),
      ).catch((error: unknown) => serverErrorIn(error)?.code);
      expect(updated === '42501' || (updated as { rowCount?: number }).rowCount === 0, name).toBe(
        true,
      );
    }
    expect((await stateOf(row.id)).attempt_count).toBe(0);
  });
});

describe('the credential’s failed-attempt count and lock time', () => {
  // Break caught: a count that starts anywhere but zero, or a lock that exists from the start (an identity locked out before it ever
  // failed).
  it('starts at zero and unlocked', async () => {
    const owner = await identity();

    const row = (
      await admin.query<{ failed_attempt_count: number; locked_until: Date | null }>(
        'select failed_attempt_count, locked_until from staff_identity where id = $1',
        [owner.id],
      )
    ).rows[0];

    expect(row).toEqual({ failed_attempt_count: 0, locked_until: null });
  });

  it('never goes below zero, and a lock needs failures and a credential to lock', async () => {
    const credentialed = await identity();
    const uncredentialed = await identity({ credentialHash: null, credentialEstablishedAt: null });

    expect(
      (
        await refusalOf('update staff_identity set failed_attempt_count = -1 where id = $1', [
          credentialed.id,
        ])
      )?.constraint,
    ).toBe('staff_identity_failed_attempts_non_negative');
    expect(
      (
        await refusalOf(
          `update staff_identity set locked_until = now() + interval '15 minutes' where id = $1`,
          [credentialed.id],
        )
      )?.constraint,
    ).toBe('staff_identity_lock_has_failures');
    expect(
      (
        await refusalOf(
          `update staff_identity set failed_attempt_count = 5, locked_until = now() + interval '15 minutes' where id = $1`,
          [uncredentialed.id],
        )
      )?.constraint,
    ).toBe('staff_identity_lock_has_failures');
    expect(
      await refusalOf(
        `update staff_identity set failed_attempt_count = 5, locked_until = now() + interval '15 minutes' where id = $1`,
        [credentialed.id],
      ),
    ).toBeUndefined();
  });

  // Break caught: the API able to write more of the identity than the two credential records it needs, or unable to take the identity
  // lock; and a read of the columns by another login.
  it('lets the API runtime read and write these two columns and still not the identity’s origin, status or name', async () => {
    const held = async (kind: string, column: string): Promise<boolean> =>
      (
        await admin.query<{ held: boolean }>(
          `select has_column_privilege('melarc_api_runtime', 'public.staff_identity', $2, $1) as held`,
          [kind, column],
        )
      ).rows[0]?.held === true;

    for (const column of ['failed_attempt_count', 'locked_until']) {
      expect(await held('SELECT', column), column).toBe(true);
      expect(await held('UPDATE', column), column).toBe(true);
      expect(await held('INSERT', column), column).toBe(false);
    }
    for (const column of ['status', 'origin', 'full_name', 'role_bundle_id', 'work_email']) {
      expect(await held('UPDATE', column), column).toBe(false);
    }
  });

  it('is changed by the authentication capability alone', async () => {
    const owner = await identity();

    await as(systemContext('authentication'), (tx) =>
      tx.execute(
        sql`update staff_identity set failed_attempt_count = 2 where id = ${owner.id}::uuid`,
      ),
    );

    const after = (
      await admin.query<{ failed_attempt_count: number }>(
        'select failed_attempt_count from staff_identity where id = $1',
        [owner.id],
      )
    ).rows[0];
    expect(after?.failed_attempt_count).toBe(2);
    const refused = await as(staffContext([]), (tx) =>
      tx.execute(
        sql`update staff_identity set failed_attempt_count = 0 where id = ${owner.id}::uuid`,
      ),
    ).catch((error: unknown) => serverErrorIn(error)?.code);
    expect(refused === '42501' || (refused as { rowCount?: number }).rowCount === 0).toBe(true);
    expect(
      (
        await admin.query<{ failed_attempt_count: number }>(
          'select failed_attempt_count from staff_identity where id = $1',
          [owner.id],
        )
      ).rows[0]?.failed_attempt_count,
    ).toBe(2);
  });

  const as = <T>(
    context: SecurityContext,
    work: (tx: Parameters<Parameters<typeof withHandle>[2]>[1]) => Promise<T>,
  ): Promise<T> => withHandle(api.service, context, (_handle, tx) => work(tx));
});
