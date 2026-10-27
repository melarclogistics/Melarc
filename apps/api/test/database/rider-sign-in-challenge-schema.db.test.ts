import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RIDER_CHALLENGE_STATES } from '../../src/platform/auth/rider/rider-vocabulary.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { withHandle } from './support/handle.js';
import { insertRider, riderRow, type RiderRow } from './support/riders.js';
import { staffContext, systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.59a, the rider's sign-in challenge (migration 0041, `rider_sign_in_challenge`) against a real PostgreSQL: what the schema itself
 * refuses (tried as the administrator, who is held to the table's checks, foreign key, unique index and guard triggers), and what the
 * API's login may do under each context (row-level security and the column grants). The behaviour (the request that issues a challenge and
 * the sign-in that spends it) is the operations' own tests.
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

const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

interface ChallengeRow {
  readonly id: string;
  readonly riderId: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly nonceHash: Buffer;
  readonly phoneHash: Buffer;
  readonly purpose: string;
  readonly audience: string;
  readonly deviceContextHash: Buffer | null;
}

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
const minutesAhead = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

function challengeRow(riderId: string | null, overrides: Partial<ChallengeRow> = {}): ChallengeRow {
  return {
    id: randomUUID(),
    riderId,
    issuedAt: minutesAgo(1),
    expiresAt: minutesAhead(4),
    nonceHash: randomBytes(32),
    phoneHash: sha('a phone'),
    purpose: 'RIDER_SIGN_IN',
    audience: 'melarc-api/local',
    deviceContextHash: null,
    ...overrides,
  };
}

async function insertChallenge(row: ChallengeRow): Promise<ChallengeRow> {
  await admin.query(
    `insert into rider_sign_in_challenge (id, rider_identity_id, issued_at, expires_at, nonce_hash, phone_hash, purpose, audience,
                                          device_context_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.id,
      row.riderId,
      row.issuedAt,
      row.expiresAt,
      row.nonceHash,
      row.phoneHash,
      row.purpose,
      row.audience,
      row.deviceContextHash,
    ],
  );
  return row;
}

const refusalOfInsert = async (row: ChallengeRow): Promise<Refusal | undefined> => {
  try {
    await insertChallenge(row);
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

const rider = (overrides: Partial<RiderRow> = {}): Promise<RiderRow> =>
  insertRider(admin, riderRow(overrides));

const stateOf = async (id: string): Promise<string> =>
  (
    await admin.query<{ state: string }>(
      'select state from rider_sign_in_challenge where id = $1',
      [id],
    )
  ).rows[0]?.state ?? 'GONE';

describe('the table repeats the closed set of the code, and a change to one fails here', () => {
  it('holds the four states of RIDER_CHALLENGE_STATES', async () => {
    const definition = (
      await admin.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
          where conname = 'rider_sign_in_challenge_state_closed' and conrelid = 'public.rider_sign_in_challenge'::regclass`,
      )
    ).rows[0]?.definition;
    const words = [
      ...new Set((definition?.match(/'[A-Za-z_]+'/g) ?? []).map((w) => w.slice(1, -1))),
    ];

    expect(words.toSorted()).toEqual([...RIDER_CHALLENGE_STATES].toSorted());
  });
});

describe('a challenge is held to the rules of the domain model', () => {
  // Break caught (§6.8): a challenge with no lifetime, one that lives before it is issued, a state outside the four.
  it('needs a lifetime that begins after the issue and one of the four states', async () => {
    const owner = await rider();
    const now = new Date();

    expect(
      (await refusalOfInsert(challengeRow(owner.id, { issuedAt: now, expiresAt: now })))
        ?.constraint,
    ).toBe('rider_sign_in_challenge_expiry_after_issue');
    expect(
      (await refusalOfInsert(challengeRow(owner.id, { issuedAt: now, expiresAt: minutesAgo(1) })))
        ?.constraint,
    ).toBe('rider_sign_in_challenge_expiry_after_issue');
    const row = await insertChallenge(challengeRow(owner.id));
    expect(
      (await refusalOf(`update rider_sign_in_challenge set state = 'LOST' where id = $1`, [row.id]))
        ?.constraint,
    ).toBe('rider_sign_in_challenge_state_closed');
  });

  // Break caught (SECURITY_DESIGN §13.6: "sign-in and enrolment challenge namespaces stay separate"): a challenge of another purpose
  // in the table, which a sign-in could then be asked to accept.
  it('has the one purpose RIDER_SIGN_IN, and an audience that is not empty', async () => {
    const owner = await rider();

    expect(
      (await refusalOfInsert(challengeRow(owner.id, { purpose: 'RIDER_DEVICE_ENROLMENT' })))
        ?.constraint,
    ).toBe('rider_sign_in_challenge_purpose_closed');
    expect((await refusalOfInsert(challengeRow(owner.id, { audience: '' })))?.constraint).toBe(
      'rider_sign_in_challenge_audience_bounded',
    );
    expect(
      (await refusalOfInsert(challengeRow(owner.id, { audience: 'a'.repeat(129) })))?.constraint,
    ).toBe('rider_sign_in_challenge_audience_bounded');
  });

  // Break caught: a hash that is not a SHA-256 (a nonce kept in clear, a phone number kept as it was typed).
  it('keeps only whole 32-byte hashes of the nonce, the number and the device context', async () => {
    const owner = await rider();

    for (const overrides of [
      { nonceHash: Buffer.from('a nonce in clear') },
      { phoneHash: Buffer.from('+999') },
      { phoneHash: randomBytes(33) },
      { deviceContextHash: Buffer.from('a device') },
    ] satisfies Partial<ChallengeRow>[]) {
      expect(
        (await refusalOfInsert(challengeRow(owner.id, overrides)))?.constraint,
        JSON.stringify(Object.keys(overrides)),
      ).toBe('rider_sign_in_challenge_hashes_whole');
    }
  });

  // Break caught: a second row for one nonce, which would let two presentations of one challenge each find a row to consume.
  it('keeps a nonce hash unique', async () => {
    const owner = await rider();
    const first = await insertChallenge(challengeRow(owner.id));

    expect(
      (await refusalOfInsert(challengeRow(owner.id, { nonceHash: first.nonceHash })))?.constraint,
    ).toBe('rider_sign_in_challenge_nonce_key');
  });

  // Break caught (§6.8: "a number that matched no rider … null"): a rider recorded for a number nobody holds is impossible, and a device
  // context with no rider would say a device exists for a number that matched none.
  it('names no rider for a number that matched none, and then no device context', async () => {
    await insertChallenge(challengeRow(null));

    expect(
      (await refusalOfInsert(challengeRow(null, { deviceContextHash: sha('a device') })))
        ?.constraint,
    ).toBe('rider_sign_in_challenge_context_needs_rider');
    expect((await refusalOfInsert(challengeRow(randomUUID())))?.constraint).toBe(
      'rider_sign_in_challenge_rider_fkey',
    );
  });

  it('belongs to a rider that exists, and keeps it: no rider is removed under its challenges', async () => {
    const owner = await rider();
    await insertChallenge(challengeRow(owner.id));

    expect(
      (await refusalOf('delete from rider_identity where id = $1', [owner.id]))?.constraint,
    ).toBe('rider_sign_in_challenge_rider_fkey');
  });

  it('is issued PENDING, whoever inserts it', async () => {
    const owner = await rider();
    const row = challengeRow(owner.id);

    for (const state of ['CONSUMED', 'EXPIRED', 'UNUSABLE']) {
      const refused = await refusalOf(
        `insert into rider_sign_in_challenge (id, rider_identity_id, issued_at, expires_at, state, nonce_hash, phone_hash, purpose, audience)
         values ($1, $2, now() - interval '1 minute', now() + interval '4 minutes', $3, $4, $5, 'RIDER_SIGN_IN', 'melarc-api/local')`,
        [row.id, owner.id, state, randomBytes(32), sha('a phone')],
      );
      expect(refused?.message, state).toMatch(/issued PENDING/);
    }
  });
});

describe('the update guard keeps a challenge to its state machine', () => {
  // Break caught: the rider, the number, the nonce or the lifetime of a challenge rewritten after it was issued (a challenge lengthened,
  // or moved to another number or device).
  it('keeps everything but its state', async () => {
    const owner = await rider();
    const other = await rider();
    const row = await insertChallenge(
      challengeRow(owner.id, { deviceContextHash: sha('a device') }),
    );
    const statements: [string, unknown[]][] = [
      [
        "update rider_sign_in_challenge set expires_at = expires_at + interval '1 hour' where id = $1",
        [row.id],
      ],
      [
        "update rider_sign_in_challenge set issued_at = issued_at - interval '1 hour' where id = $1",
        [row.id],
      ],
      [
        'update rider_sign_in_challenge set rider_identity_id = $2 where id = $1',
        [row.id, other.id],
      ],
      ['update rider_sign_in_challenge set rider_identity_id = null where id = $1', [row.id]],
      [
        'update rider_sign_in_challenge set nonce_hash = $2 where id = $1',
        [row.id, randomBytes(32)],
      ],
      [
        'update rider_sign_in_challenge set phone_hash = $2 where id = $1',
        [row.id, sha('another')],
      ],
      ['update rider_sign_in_challenge set device_context_hash = null where id = $1', [row.id]],
      ["update rider_sign_in_challenge set audience = 'another' where id = $1", [row.id]],
      ['update rider_sign_in_challenge set id = gen_random_uuid() where id = $1', [row.id]],
    ];

    for (const [statement, values] of statements) {
      expect((await refusalOf(statement, values))?.message, statement).toMatch(
        /keeps everything but its state/,
      );
    }
    expect(await stateOf(row.id)).toBe('PENDING');
  });

  // Break caught (§6.8: "EXPIRED and UNUSABLE are different terminal states"): a terminal challenge brought back, or changed.
  it('lets only a PENDING challenge change: the three other states are terminal', async () => {
    const owner = await rider();
    const consumed = await insertChallenge(challengeRow(owner.id));
    await admin.query(`update rider_sign_in_challenge set state = 'CONSUMED' where id = $1`, [
      consumed.id,
    ]);
    const unusable = await insertChallenge(challengeRow(owner.id));
    await admin.query(`update rider_sign_in_challenge set state = 'UNUSABLE' where id = $1`, [
      unusable.id,
    ]);
    const expired = await insertChallenge(
      challengeRow(owner.id, { issuedAt: minutesAgo(10), expiresAt: minutesAgo(5) }),
    );
    await admin.query(`update rider_sign_in_challenge set state = 'EXPIRED' where id = $1`, [
      expired.id,
    ]);

    for (const row of [consumed, unusable, expired]) {
      for (const state of ['PENDING', 'CONSUMED', 'UNUSABLE']) {
        if (state === (await stateOf(row.id))) continue;
        expect(
          (
            await refusalOf(`update rider_sign_in_challenge set state = $2 where id = $1`, [
              row.id,
              state,
            ])
          )?.message,
          `${row.id} ${state}`,
        ).toMatch(/only a PENDING challenge changes/);
      }
    }
  });

  // Break caught: a challenge marked expired while it still has time (a live sign-in ended early), or consumed after its time (a signature
  // accepted on an expired challenge).
  it('expires only once its time has passed, and is consumed only before it', async () => {
    const owner = await rider();
    const live = await insertChallenge(challengeRow(owner.id));
    const lapsed = await insertChallenge(
      challengeRow(owner.id, { issuedAt: minutesAgo(10), expiresAt: minutesAgo(5) }),
    );

    expect(
      (
        await refusalOf(`update rider_sign_in_challenge set state = 'EXPIRED' where id = $1`, [
          live.id,
        ])
      )?.message,
    ).toMatch(/expires only when its time has passed/);
    const late = await refusalOf(
      `update rider_sign_in_challenge set state = 'CONSUMED' where id = $1`,
      [lapsed.id],
    );
    expect(late?.message).toMatch(/consumed only while it has not expired/);
    // A consumption that lost a race with the clock says so in a form the application can tell from every other refusal of the table
    // (migration 0021's convention); the early expiry above, and every other guard rule, state no reason.
    expect(late?.detail).toBe('reason=CHALLENGE_EXPIRED');
    expect(
      (
        await refusalOf(`update rider_sign_in_challenge set state = 'EXPIRED' where id = $1`, [
          live.id,
        ])
      )?.detail,
    ).toBeUndefined();
    await admin.query(`update rider_sign_in_challenge set state = 'CONSUMED' where id = $1`, [
      live.id,
    ]);
    await admin.query(`update rider_sign_in_challenge set state = 'EXPIRED' where id = $1`, [
      lapsed.id,
    ]);
    expect(await stateOf(live.id)).toBe('CONSUMED');
    expect(await stateOf(lapsed.id)).toBe('EXPIRED');
  });

  // Break caught: a challenge that cannot be ended as unusable before its time (a binding that does not hold must finish it at once).
  it('becomes unusable at any time while it is PENDING', async () => {
    const owner = await rider();
    const live = await insertChallenge(challengeRow(owner.id));

    await admin.query(`update rider_sign_in_challenge set state = 'UNUSABLE' where id = $1`, [
      live.id,
    ]);

    expect(await stateOf(live.id)).toBe('UNUSABLE');
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

  // Break caught (the mutation run of 27 October 2026): row-level security enabled and not forced, which leaves the owner of the table, and
  // so anything that becomes the owner, outside every policy below.
  it('is owned by melarc_owner with row-level security enabled and forced, so that the owner is held to the policies too', async () => {
    const found = await admin.query<{ owner: string; enabled: boolean; forced: boolean }>(
      `select pg_get_userbyid(relowner) as owner, relrowsecurity as enabled, relforcerowsecurity as forced
         from pg_class where oid = 'public.rider_sign_in_challenge'::regclass`,
    );

    expect(found.rows[0]).toEqual({ owner: 'melarc_owner', enabled: true, forced: true });
  });

  // Break caught (the mutation run of 27 October 2026): the policy's own condition on an issued state dropped, which the insert trigger hides
  // from every test that leaves the trigger in place. The two layers each hold the rule.
  it('refuses, by its policy alone, a challenge issued in any state but PENDING, with the insert trigger stood aside', async () => {
    const owner = await rider();
    await admin.query(
      `alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_insert_guard`,
    );
    try {
      for (const state of ['CONSUMED', 'EXPIRED', 'UNUSABLE']) {
        const refused = await failure(() =>
          as(systemContext('authentication'), (tx) =>
            tx.execute(sql`insert into rider_sign_in_challenge (id, rider_identity_id, issued_at, expires_at, state, nonce_hash, phone_hash, purpose, audience)
              values (gen_random_uuid(), ${owner.id}::uuid, clock_timestamp(), clock_timestamp() + interval '5 minutes', ${state}, ${randomBytes(32)},
                      ${sha('a phone')}, 'RIDER_SIGN_IN', 'melarc-api/local')`),
          ),
        );
        expect(refused, state).toBe('42501');
      }
    } finally {
      await admin.query(
        `alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_insert_guard`,
      );
    }
  });

  it('holds SELECT and INSERT on the table and an UPDATE of the state alone, and no DELETE', async () => {
    const privileges = async (column?: string): Promise<string[]> => {
      const kinds =
        column === undefined
          ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
          : ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
      const held: string[] = [];
      for (const kind of kinds) {
        const result = await admin.query<{ held: boolean }>(
          column === undefined
            ? `select has_table_privilege('melarc_api_runtime', 'public.rider_sign_in_challenge', $1) as held`
            : `select has_column_privilege('melarc_api_runtime', 'public.rider_sign_in_challenge', $2, $1) as held`,
          column === undefined ? [kind] : [kind, column],
        );
        if (result.rows[0]?.held === true) held.push(kind);
      }
      return held;
    };

    expect(await privileges()).toEqual(['SELECT', 'INSERT']);
    expect(await privileges('state')).toContain('UPDATE');
    for (const column of [
      'id',
      'rider_identity_id',
      'issued_at',
      'expires_at',
      'nonce_hash',
      'phone_hash',
      'purpose',
      'audience',
      'device_context_hash',
    ]) {
      expect(await privileges(column), column).not.toContain('UPDATE');
    }
  });

  it('inserts, reads and updates a challenge as the authentication capability, and the guards still apply', async () => {
    const owner = await rider();
    const id = randomUUID();
    await as(systemContext('authentication'), (tx) =>
      tx.execute(sql`insert into rider_sign_in_challenge (id, rider_identity_id, issued_at, expires_at, nonce_hash, phone_hash, purpose, audience)
        values (${id}::uuid, ${owner.id}::uuid, clock_timestamp(), clock_timestamp() + interval '5 minutes', ${randomBytes(32)},
                ${sha('a phone')}, 'RIDER_SIGN_IN', 'melarc-api/local')`),
    );

    const read = await as(systemContext('authentication'), (tx) =>
      tx.execute(sql`select state from rider_sign_in_challenge where id = ${id}::uuid`),
    );
    expect(read.rows[0]).toEqual({ state: 'PENDING' });
    await as(systemContext('authentication'), (tx) =>
      tx.execute(sql`update rider_sign_in_challenge set state = 'CONSUMED' where id = ${id}::uuid`),
    );
    expect(await stateOf(id)).toBe('CONSUMED');
    expect(
      await failure(() =>
        as(systemContext('authentication'), (tx) =>
          tx.execute(
            sql`update rider_sign_in_challenge set expires_at = expires_at + interval '1 day' where id = ${id}::uuid`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  // Break caught: a policy that lets another capability, or a human principal, read or write a challenge (a challenge holds the hash of
  // the number a sign-in is for, and whether it matched a rider).
  it('shows no challenge to a staff member or to another capability the API holds, and lets none be written', async () => {
    const owner = await rider();
    const row = await insertChallenge(challengeRow(owner.id));
    const contexts: [string, SecurityContext][] = [
      ['a staff member', staffContext([])],
      ['the rate limit capability', systemContext('rate_limit')],
    ];

    for (const [name, context] of contexts) {
      const seen = await as(context, (tx) =>
        tx.execute(sql`select id from rider_sign_in_challenge where id = ${row.id}::uuid`),
      );
      expect(seen.rows, name).toEqual([]);
      expect(
        await failure(() =>
          as(context, (tx) =>
            tx.execute(sql`insert into rider_sign_in_challenge (id, rider_identity_id, issued_at, expires_at, nonce_hash, phone_hash, purpose, audience)
              values (gen_random_uuid(), ${owner.id}::uuid, clock_timestamp(), clock_timestamp() + interval '5 minutes', ${randomBytes(32)},
                      ${sha('a phone')}, 'RIDER_SIGN_IN', 'melarc-api/local')`),
          ),
        ),
        name,
      ).toBeDefined();
      const updated = await as(context, (tx) =>
        tx.execute(
          sql`update rider_sign_in_challenge set state = 'CONSUMED' where id = ${row.id}::uuid`,
        ),
      ).catch((error: unknown) => serverErrorIn(error)?.code);
      expect(updated === '42501' || (updated as { rowCount?: number }).rowCount === 0, name).toBe(
        true,
      );
    }
    expect(await stateOf(row.id)).toBe('PENDING');
  });

  it('can be deleted by nobody the API holds: the history of a sign-in stays', async () => {
    const owner = await rider();
    const row = await insertChallenge(challengeRow(owner.id));

    expect(
      await failure(() =>
        as(systemContext('authentication'), (tx) =>
          tx.execute(sql`delete from rider_sign_in_challenge where id = ${row.id}::uuid`),
        ),
      ),
    ).toBe('42501');
    expect(await stateOf(row.id)).toBe('PENDING');
  });
});
