import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTINUATION_PURPOSE,
  CONTINUED_FROM_PURPOSES,
  EPISODE_PURPOSES,
  GRANT_PRINCIPAL_TYPES,
  GRANT_TOKEN_HASH_BYTES,
  NO_EXPIRY_PURPOSE,
  PURPOSES_OF_PRINCIPAL,
  RIDER_DEVICE_PURPOSES,
  SETUP_GRANT_PURPOSES,
  SETUP_GRANT_STATES,
} from '../../src/platform/auth/setup-grants/setup-grant-vocabulary.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { grantRow, insertGrant, setGrantState, type GrantRow } from './support/credentials.js';
import { hashOf } from './support/identities.js';
import { withHandle } from './support/handle.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import { insertVendor, SOME_SECRET_HASH, vendorRow } from './support/vendors.js';

/**
 * S0.29, the setup grant (migration 0018, `setup_grant`), against a real PostgreSQL. What the schema itself refuses (the
 * constraints, the lineage and the guard triggers, tried as the administrator so that nothing but the schema is in the way), and
 * what each login reaches (row-level security and the column grants, as the API's login under the authentication capability and as
 * the delivery worker's under its own). The factor that a grant leads to is `mfa-factor-schema.db.test.ts`; the store that issues
 * and consumes grants is `setup-grant-store.db.test.ts`. No operation issues a grant to a person yet.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let work: BuiltService;
beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 2 });
  work = buildService(database, { poolMax: 2, login: WORKER_RUNTIME_ROLE });
});

afterAll(async () => {
  await admin.end();
  await api.close();
  await work.close();
  await database.drop();
});

interface Refusal {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
  /** The machine-readable reason of a refusal that states one (`reason=...`), which no check or other guard rule does. */
  readonly detail: string | undefined;
}

/** What the database said to a statement, or `undefined` when it ran: the code, the constraint it names and its message. */
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

const refusalOfInsert = async (row: GrantRow): Promise<Refusal | undefined> => {
  try {
    await insertGrant(admin, row);
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

const grant = (overrides: Partial<GrantRow> = {}): Promise<GrantRow> =>
  insertGrant(admin, grantRow(overrides));
/**
 * A new principal for a vendor grant: an active account of an active organisation, as the vendor guard (0035) requires, holding a secret
 * for a browser grant and none for a setup.
 */
const vendorAccount = async (holdsSecret: boolean): Promise<string> =>
  (await insertVendor(admin, vendorRow(holdsSecret ? { secretHash: SOME_SECRET_HASH } : {})))
    .accountId;
/**
 * A new principal for a rider grant: a rider in a status a device is bound in, as the rider guard (0040) requires, with no device for a
 * first registration and a device it holds for a re-registration.
 */
const riderPrincipal = async (
  purpose: 'RIDER_DEVICE_ENROLMENT' | 'RIDER_DEVICE_REREGISTRATION',
): Promise<string> => {
  const rider = await insertRider(admin, riderRow());
  if (purpose === 'RIDER_DEVICE_REREGISTRATION') await insertRiderDevice(admin, rider.id);
  return rider.id;
};
const ago = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

const PURPOSES_OF = {
  STAFF: ['STAFF_CREDENTIAL_SETUP', 'MFA_ENROLMENT', 'MFA_REENROLMENT', 'BOOTSTRAP_SETUP'],
  RIDER: ['RIDER_DEVICE_ENROLMENT', 'RIDER_DEVICE_REREGISTRATION'],
  VENDOR: ['VENDOR_CREDENTIAL_SETUP', 'VENDOR_DEVICE_ENROLMENT'],
} as const;

const RIDER_CHALLENGE = hashOf('attestation challenge');

/** The quoted words of a constraint's or a function's definition, which is how the table states a closed set. */
const literalsOf = async (statement: string, name: string): Promise<string[]> => {
  const result = await admin.query<{ definition: string }>(statement, [name]);
  const definition = result.rows[0]?.definition ?? '';
  return [...new Set((definition.match(/'[A-Za-z_]+'/g) ?? []).map((word) => word.slice(1, -1)))];
};
const constraintLiterals = (name: string): Promise<string[]> =>
  literalsOf(
    `select pg_get_constraintdef(oid) as definition from pg_constraint where conname = $1 and conrelid = 'public.setup_grant'::regclass`,
    name,
  );
const functionLiterals = (name: string): Promise<string[]> =>
  literalsOf(
    `select pg_get_functiondef(p.oid) as definition from pg_proc p where p.proname = $1 and p.pronamespace = 'melarc'::regnamespace`,
    name,
  );

describe('the table repeats the closed sets of the code (setup-grant-vocabulary.ts), and a change to one fails here', () => {
  it.each([
    ['setup_grant_principal_closed', GRANT_PRINCIPAL_TYPES],
    ['setup_grant_purpose_closed', SETUP_GRANT_PURPOSES],
    ['setup_grant_state_closed', SETUP_GRANT_STATES],
    ['setup_grant_episode_by_purpose', EPISODE_PURPOSES],
    ['setup_grant_attestation_by_purpose', RIDER_DEVICE_PURPOSES],
    ['setup_grant_continuation_is_enrolment', [CONTINUATION_PURPOSE]],
    ['setup_grant_expiry_by_purpose', [NO_EXPIRY_PURPOSE]],
    [
      'setup_grant_purpose_by_principal',
      [
        ...GRANT_PRINCIPAL_TYPES,
        ...GRANT_PRINCIPAL_TYPES.flatMap((type) => PURPOSES_OF_PRINCIPAL[type]),
      ],
    ],
  ])('holds the set of %s', async (name, expected) => {
    expect((await constraintLiterals(name)).toSorted()).toEqual([...expected].toSorted());
  });

  // Break caught: the purposes a continuation may follow drifting between the guard (SQL) and the code that issues one.
  it('lets a continuation follow exactly the purposes the code lists', async () => {
    const literals = await functionLiterals('setup_grant_insert_guard');

    for (const purpose of CONTINUED_FROM_PURPOSES) expect(literals).toContain(purpose);
    expect(literals.filter((word) => /^[A-Z]+(_[A-Z]+)+$/.test(word)).toSorted()).toEqual(
      [...CONTINUED_FROM_PURPOSES].toSorted(),
    );
  });

  it('holds a token hash of the length the code names', async () => {
    const result = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'setup_grant_token_hash_is_sha256'`,
    );
    expect(result.rows[0]?.definition).toContain(`= ${String(GRANT_TOKEN_HASH_BYTES)}`);
  });
});

describe('a setup grant is held to the rules of the domain model', () => {
  // Break caught (domain-model.md §6.8): a purpose the enum does not have, or a state the machine does not have.
  it('has one of the eight purposes, one of the three principal types and one of the four states', async () => {
    expect((await refusalOfInsert(grantRow({ purpose: 'VENDOR_CREDENTIAL_RECOVERY' })))?.code).toBe(
      '23514',
    );
    expect((await refusalOfInsert(grantRow({ principalType: 'ADMIN' as 'STAFF' })))?.code).toBe(
      '23514',
    );
    const id = (await grant()).id;
    expect(
      (await refusalOf(`update setup_grant set state = 'REVOKED' where id = $1`, [id]))?.code,
    ).toBe('23514');
  });

  // Break caught: a purpose granted to the wrong kind of principal (a staff identity given a rider's device enrolment, a vendor a staff
  // password setup), which the principal-bound grant could then be presented for.
  it('pairs each purpose with the principal it is for, and with no other', async () => {
    for (const [type, purposes] of Object.entries(PURPOSES_OF)) {
      for (const purpose of purposes) {
        const rider =
          type === 'RIDER'
            ? {
                attestationChallengeHash: RIDER_CHALLENGE,
                principalId: await riderPrincipal(
                  purpose as 'RIDER_DEVICE_ENROLMENT' | 'RIDER_DEVICE_REREGISTRATION',
                ),
              }
            : {};
        const vendor =
          type === 'VENDOR'
            ? { principalId: await vendorAccount(purpose === 'VENDOR_DEVICE_ENROLMENT') }
            : {};
        expect(
          await refusalOfInsert(
            grantRow({ principalType: type as 'STAFF', purpose, ...rider, ...vendor }),
          ),
        ).toBeUndefined();
      }
    }
    for (const [type, purpose] of [
      ['STAFF', 'RIDER_DEVICE_ENROLMENT'],
      ['STAFF', 'VENDOR_CREDENTIAL_SETUP'],
      ['VENDOR', 'STAFF_CREDENTIAL_SETUP'],
      ['VENDOR', 'MFA_ENROLMENT'],
      ['RIDER', 'VENDOR_DEVICE_ENROLMENT'],
      ['RIDER', 'BOOTSTRAP_SETUP'],
    ] as const) {
      // The challenge belongs to the rider purposes alone, so each row below breaks the pairing and nothing else. A vendor row names a
      // real account and a rider row a real rider, so the guards (0035 and 0040, triggers that run before the table's checks) admit
      // them and the pairing is what refuses.
      const principal =
        type === 'VENDOR'
          ? { principalId: await vendorAccount(false) }
          : type === 'RIDER'
            ? { principalId: await riderPrincipal('RIDER_DEVICE_ENROLMENT') }
            : {};
      const refusal = await refusalOfInsert(
        grantRow({
          principalType: type,
          purpose,
          attestationChallengeHash: purpose.startsWith('RIDER_') ? RIDER_CHALLENGE : null,
          ...principal,
        }),
      );
      expect(refusal?.constraint, `${type} ${purpose}`).toBe('setup_grant_purpose_by_principal');
    }
  });

  // Break caught: a token stored in some other form than its SHA-256 (the displayed text, a longer value), or two grants sharing one.
  it('stores a token hash of 32 bytes, and no two grants share one', async () => {
    expect((await refusalOfInsert(grantRow({ tokenHash: Buffer.alloc(31, 1) })))?.code).toBe(
      '23514',
    );
    expect((await refusalOfInsert(grantRow({ tokenHash: Buffer.alloc(33, 1) })))?.code).toBe(
      '23514',
    );
    const shared = hashOf('shared token');
    await grant({ tokenHash: shared });

    expect((await refusalOfInsert(grantRow({ tokenHash: shared })))?.code).toBe('23505');
  });

  // Break caught (§6.8: "Null only for BOOTSTRAP_SETUP"): a grant with no end that is not the bootstrap secret, which would be a standing
  // key, or a bootstrap secret with an end, which a clock could then strand; or a grant that ends before it began.
  it('has no expiry for BOOTSTRAP_SETUP alone, and an expiry after the issue for every other purpose', async () => {
    expect((await refusalOfInsert(grantRow({ expiresAt: null })))?.constraint).toBe(
      'setup_grant_expiry_by_purpose',
    );
    expect(
      (await refusalOfInsert(grantRow({ purpose: 'BOOTSTRAP_SETUP', expiresAt: ago(-30) })))
        ?.constraint,
    ).toBe('setup_grant_expiry_by_purpose');
    const issuedAt = ago(5);
    expect((await refusalOfInsert(grantRow({ issuedAt, expiresAt: issuedAt })))?.constraint).toBe(
      'setup_grant_expiry_by_purpose',
    );
    await grant({ purpose: 'BOOTSTRAP_SETUP' });
    await grant();
  });

  // Break caught: a consumption with no moment, or a moment on a grant that was not consumed, so that "used once" would mean two things.
  it('records when it was consumed exactly when it is CONSUMED, and not before it was issued', async () => {
    const row = await grant();

    expect(
      (await refusalOf(`update setup_grant set state = 'CONSUMED' where id = $1`, [row.id]))
        ?.constraint,
    ).toBe('setup_grant_consumed_whole');
    expect(
      (await refusalOf(`update setup_grant set consumed_at = now() where id = $1`, [row.id]))
        ?.constraint,
    ).toBe('setup_grant_consumed_whole');
    expect(
      (
        await refusalOf(
          `update setup_grant set state = 'CONSUMED', consumed_at = issued_at - interval '1 second' where id = $1`,
          [row.id],
        )
      )?.constraint,
    ).toBe('setup_grant_consumed_whole');
    await setGrantState(admin, row.id, 'CONSUMED');
  });

  // Break caught (§6.8): a reset episode on a grant that no reset can have issued (a vendor's setup, a staff credential setup).
  it('carries a reset episode on an MFA enrolment or re-enrolment grant only', async () => {
    const episodeId = randomUUID();
    expect((await refusalOfInsert(grantRow({ episodeId })))?.constraint).toBe(
      'setup_grant_episode_by_purpose',
    );
    expect(
      (await refusalOfInsert(grantRow({ purpose: 'BOOTSTRAP_SETUP', episodeId })))?.constraint,
    ).toBe('setup_grant_episode_by_purpose');
    await grant({ purpose: 'MFA_REENROLMENT', episodeId });
    await grant({ purpose: 'MFA_ENROLMENT', episodeId });
    await grant({ purpose: 'MFA_ENROLMENT' });
  });

  // Break caught (§6.8: "Set only for the two rider device purposes"): the challenge hash of a grant that is not a rider's, or a
  // rider's device grant with none, which `completeRiderDeviceEnrolment` could not compare the attested challenge with.
  it('holds an attestation challenge hash of 32 bytes for the two rider device purposes, and for no other', async () => {
    for (const purpose of PURPOSES_OF.RIDER) {
      const rider = {
        principalType: 'RIDER',
        purpose,
        principalId: await riderPrincipal(purpose),
      } as const;
      expect(
        (await refusalOfInsert(grantRow({ ...rider, attestationChallengeHash: null })))?.constraint,
      ).toBe('setup_grant_attestation_by_purpose');
      expect(
        (
          await refusalOfInsert(
            grantRow({ ...rider, attestationChallengeHash: Buffer.alloc(16, 1) }),
          )
        )?.constraint,
      ).toBe('setup_grant_attestation_by_purpose');
      await grant({ ...rider, attestationChallengeHash: RIDER_CHALLENGE });
    }
    expect(
      (await refusalOfInsert(grantRow({ attestationChallengeHash: RIDER_CHALLENGE })))?.constraint,
    ).toBe('setup_grant_attestation_by_purpose');
  });

  // Break caught: a grant issued already consumed, expired or superseded, which would arrive past the machine's only creating transition.
  it('is issued PENDING and unconsumed, whoever inserts it', async () => {
    for (const state of ['CONSUMED', 'EXPIRED', 'SUPERSEDED']) {
      const row = grantRow();
      const refusal = await refusalOf(
        `insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state)
         values ($1, 'STAFF', $2, 'STAFF_CREDENTIAL_SETUP', $3, $4, $5, $6)`,
        [row.id, row.principalId, row.tokenHash, row.issuedAt, row.expiresAt, state],
      );
      expect(refusal?.code, state).toBe('23514');
      expect(refusal?.message, state).toMatch(/issued PENDING/);
    }
  });
});

describe('a principal has at most one PENDING grant of a purpose', () => {
  // Break caught (§6.8: "at most one grant of the episode is PENDING"; "issuing a new grant supersedes any PENDING grant of the same
  // purpose"): two live grants of one purpose for one principal, which would leave two tokens that each work.
  it('refuses a second PENDING grant of the purpose until the first has ended', async () => {
    const principalId = randomUUID();
    const first = await grant({ principalId });

    const second = await refusalOfInsert(grantRow({ principalId }));
    expect(second?.code).toBe('23505');
    expect(second?.constraint).toBe('setup_grant_one_pending_key');

    await setGrantState(admin, first.id, 'CONSUMED');
    await grant({ principalId });
  });

  it('keys the rule on the principal and on the purpose', async () => {
    // A vendor account's id, so the vendor grant below names a real account; the staff grants carry the same id as another principal.
    const principalId = await vendorAccount(false);
    await grant({ principalId });
    await grant({ principalId: randomUUID() });
    await grant({ principalId, purpose: 'MFA_ENROLMENT' });
    // The same id with another principal type is another principal.
    await grant({
      principalType: 'VENDOR',
      principalId,
      purpose: 'VENDOR_CREDENTIAL_SETUP',
    });
  });
});

describe('the lineage of a grant is explicit, principal-consistent and held by the database (GBT-B14, constraint half)', () => {
  const asSuperseded = async (overrides: Partial<GrantRow> = {}): Promise<GrantRow> => {
    const row = await grant(overrides);
    await setGrantState(admin, row.id, 'SUPERSEDED');
    return row;
  };

  // Break caught (§6.8: "a composite foreign key that includes the principal"): a lineage reference to another principal's grant, which
  // would let one person's grant be named as the predecessor or the source of another's.
  it('refuses a lineage reference to another principal’s grant, in either column', async () => {
    const other = await asSuperseded();
    const otherConsumed = await grant({ principalId: randomUUID() });
    await setGrantState(admin, otherConsumed.id, 'CONSUMED');

    const supersedes = await refusalOfInsert(grantRow({ supersedesGrantId: other.id }));
    expect(supersedes?.code).toBe('23503');
    expect(supersedes?.constraint).toBe('setup_grant_supersedes_fkey');

    const continues = await refusalOfInsert(
      grantRow({ purpose: 'MFA_ENROLMENT', continuedFromGrantId: otherConsumed.id }),
    );
    expect(continues?.code).toBe('23503');
    expect(continues?.constraint).toBe('setup_grant_continued_from_fkey');
  });

  it('refuses a reference to a grant that does not exist, and a grant that names itself', async () => {
    expect((await refusalOfInsert(grantRow({ supersedesGrantId: randomUUID() })))?.code).toBe(
      '23503',
    );
    const id = randomUUID();
    const self = await refusalOfInsert(grantRow({ id, supersedesGrantId: id }));
    expect(self?.code).toBe('23514');
    expect(self?.constraint).toBe('setup_grant_no_self_lineage');
  });

  // Break caught: a grant that is both a reissue and a continuation, so that "why does this grant exist" has two answers.
  it('carries at most one of the two lineage columns', async () => {
    const principalId = randomUUID();
    // Each target is a valid one for its column, so that the lineage rules of the guard pass and only the CHECK is left to refuse.
    const superseded = await asSuperseded({ principalId, purpose: 'MFA_ENROLMENT' });
    const consumed = await grant({ principalId, purpose: 'MFA_REENROLMENT' });
    await setGrantState(admin, consumed.id, 'CONSUMED');

    const refusal = await refusalOfInsert(
      grantRow({
        principalId,
        purpose: 'MFA_ENROLMENT',
        supersedesGrantId: superseded.id,
        continuedFromGrantId: consumed.id,
      }),
    );

    expect(refusal?.constraint).toBe('setup_grant_one_lineage');
  });

  describe('a reissue names the grant it replaced', () => {
    // Break caught (§6.8: "a supersedes_grant_id target has the same purpose and episode_id and becomes SUPERSEDED when this grant is
    // inserted"): a reissue that names a grant that is still live, or one that ended some other way, or one of another purpose.
    it('names a grant of the same principal and purpose that was superseded', async () => {
      const principalId = randomUUID();
      const first = await asSuperseded({ principalId });

      const second = await grant({ principalId, supersedesGrantId: first.id });

      const stored = await admin.query(
        `select supersedes_grant_id from setup_grant where id = $1`,
        [second.id],
      );
      expect(stored.rows[0]).toEqual({ supersedes_grant_id: first.id });
    });

    it.each([
      ['a grant that is still PENDING', 'PENDING'],
      ['a grant that was CONSUMED', 'CONSUMED'],
      ['a grant that EXPIRED', 'EXPIRED'],
    ])('refuses to name %s', async (_label, state) => {
      const principalId = randomUUID();
      const target = await grant(
        state === 'EXPIRED'
          ? { principalId, issuedAt: ago(60), expiresAt: ago(30) }
          : { principalId },
      );
      if (state !== 'PENDING') {
        await setGrantState(admin, target.id, state as 'CONSUMED' | 'EXPIRED');
      }

      // For a grant that is still PENDING the unique index would refuse a second one as well; the guard runs first (a BEFORE trigger),
      // so it is the lineage rule that is shown here.
      const refusal = await refusalOfInsert(
        grantRow({ principalId, supersedesGrantId: target.id }),
      );

      expect(refusal?.code).toBe('23514');
      expect(refusal?.message).toMatch(
        /supersedes a SUPERSEDED grant of the same purpose and episode/,
      );
    });

    it('refuses to name a grant of another purpose or of another episode', async () => {
      const principalId = randomUUID();
      const otherPurpose = await asSuperseded({ principalId, purpose: 'MFA_ENROLMENT' });
      expect(
        (
          await refusalOfInsert(
            grantRow({
              principalId,
              purpose: 'MFA_REENROLMENT',
              supersedesGrantId: otherPurpose.id,
            }),
          )
        )?.message,
      ).toMatch(/supersedes a SUPERSEDED grant of the same purpose and episode/);

      const episode = randomUUID();
      const inEpisode = await asSuperseded({
        principalId,
        purpose: 'MFA_REENROLMENT',
        episodeId: episode,
      });
      for (const episodeId of [null, randomUUID()]) {
        expect(
          (
            await refusalOfInsert(
              grantRow({
                principalId,
                purpose: 'MFA_REENROLMENT',
                episodeId,
                supersedesGrantId: inEpisode.id,
              }),
            )
          )?.message,
        ).toMatch(/supersedes a SUPERSEDED grant of the same purpose and episode/);
      }
      await grant({
        principalId,
        purpose: 'MFA_REENROLMENT',
        episodeId: episode,
        supersedesGrantId: inEpisode.id,
      });
    });

    // Break caught: a predecessor named twice, which would make the chain a tree and "the grant that replaced this one" ambiguous.
    it('is named by at most one successor', async () => {
      const principalId = randomUUID();
      const first = await asSuperseded({ principalId });
      const second = await grant({ principalId, supersedesGrantId: first.id });
      await setGrantState(admin, second.id, 'CONSUMED');

      const refusal = await refusalOfInsert(grantRow({ principalId, supersedesGrantId: first.id }));

      expect(refusal?.code).toBe('23505');
      expect(refusal?.constraint).toBe('setup_grant_supersedes_key');
    });
  });

  describe('a continuation names the grant whose consumption produced it', () => {
    const consumed = async (overrides: Partial<GrantRow> = {}): Promise<GrantRow> => {
      const row = await grant(overrides);
      await setGrantState(admin, row.id, 'CONSUMED');
      return row;
    };

    // Break caught (§6.8): a continuation that is not an MFA enrolment grant, or that follows a grant the three creating purposes do
    // not include, or one that was never consumed.
    it.each([['STAFF_CREDENTIAL_SETUP'], ['BOOTSTRAP_SETUP'], ['MFA_REENROLMENT']])(
      'names a CONSUMED %s grant of the same principal',
      async (purpose) => {
        const principalId = randomUUID();
        const source = await consumed({ principalId, purpose });

        const next = await grant({
          principalId,
          purpose: 'MFA_ENROLMENT',
          continuedFromGrantId: source.id,
        });

        const stored = await admin.query(
          `select continued_from_grant_id from setup_grant where id = $1`,
          [next.id],
        );
        expect(stored.rows[0]).toEqual({ continued_from_grant_id: source.id });
      },
    );

    it('refuses a source that is not CONSUMED', async () => {
      const principalId = randomUUID();
      const pending = await grant({ principalId });

      const refusal = await refusalOfInsert(
        grantRow({ principalId, purpose: 'MFA_ENROLMENT', continuedFromGrantId: pending.id }),
      );

      expect(refusal?.code).toBe('23514');
      expect(refusal?.message).toMatch(
        /continues the CONSUMED grant of the same episode that produced it/,
      );
    });

    it('refuses a source of a purpose that creates no factor', async () => {
      const principalId = randomUUID();
      const enrolment = await consumed({ principalId, purpose: 'MFA_ENROLMENT' });

      const refusal = await refusalOfInsert(
        grantRow({ principalId, purpose: 'MFA_ENROLMENT', continuedFromGrantId: enrolment.id }),
      );

      expect(refusal?.message).toMatch(
        /continues the CONSUMED grant of the same episode that produced it/,
      );
    });

    it('is an MFA_ENROLMENT grant and nothing else', async () => {
      const principalId = randomUUID();
      const source = await consumed({ principalId });

      const refusal = await refusalOfInsert(
        grantRow({ principalId, purpose: 'MFA_REENROLMENT', continuedFromGrantId: source.id }),
      );

      expect(refusal?.constraint).toBe('setup_grant_continuation_is_enrolment');
    });

    // Break caught: a continuation in a different episode from the grant it continues, which would graft one reset onto another.
    it('belongs to the episode of the grant it continues', async () => {
      const principalId = randomUUID();
      const episode = randomUUID();
      const source = await consumed({
        principalId,
        purpose: 'MFA_REENROLMENT',
        episodeId: episode,
      });

      for (const episodeId of [null, randomUUID()]) {
        expect(
          (
            await refusalOfInsert(
              grantRow({
                principalId,
                purpose: 'MFA_ENROLMENT',
                episodeId,
                continuedFromGrantId: source.id,
              }),
            )
          )?.message,
        ).toMatch(/continues the CONSUMED grant of the same episode that produced it/);
      }
      await grant({
        principalId,
        purpose: 'MFA_ENROLMENT',
        episodeId: episode,
        continuedFromGrantId: source.id,
      });
    });
  });

  // Break caught (the evidence of S0.29): "two grants of one episode keep their lineage". Reissue and continuation are different
  // relationships and each survives the state changes that follow.
  it('keeps the lineage of two grants of one episode through every later change of state', async () => {
    const principalId = randomUUID();
    const episodeId = randomUUID();
    const first = await grant({ principalId, purpose: 'MFA_REENROLMENT', episodeId });
    await setGrantState(admin, first.id, 'SUPERSEDED');
    const second = await grant({
      principalId,
      purpose: 'MFA_REENROLMENT',
      episodeId,
      supersedesGrantId: first.id,
    });
    await setGrantState(admin, second.id, 'CONSUMED');
    const continuation = await grant({
      principalId,
      purpose: 'MFA_ENROLMENT',
      episodeId,
      continuedFromGrantId: second.id,
    });
    await setGrantState(admin, continuation.id, 'CONSUMED');

    const stored = await admin.query(
      `select id, episode_id, supersedes_grant_id, continued_from_grant_id, state from setup_grant
        where principal_id = $1 order by issued_at, id`,
      [principalId],
    );

    const byId = new Map(
      (
        stored.rows as {
          id: string;
          episode_id: string;
          supersedes_grant_id: string | null;
          continued_from_grant_id: string | null;
          state: string;
        }[]
      ).map((row) => [row.id, row]),
    );
    expect(byId.get(first.id)).toMatchObject({
      episode_id: episodeId,
      supersedes_grant_id: null,
      continued_from_grant_id: null,
      state: 'SUPERSEDED',
    });
    expect(byId.get(second.id)).toMatchObject({
      episode_id: episodeId,
      supersedes_grant_id: first.id,
      continued_from_grant_id: null,
      state: 'CONSUMED',
    });
    expect(byId.get(continuation.id)).toMatchObject({
      episode_id: episodeId,
      supersedes_grant_id: null,
      continued_from_grant_id: second.id,
      state: 'CONSUMED',
    });
  });

  it('does not let a grant that another names be removed', async () => {
    const principalId = randomUUID();
    const first = await asSuperseded({ principalId });
    await grant({ principalId, supersedesGrantId: first.id });

    const refusal = await refusalOf(`delete from setup_grant where id = $1`, [first.id]);

    // RESTRICT is reported as restrict_violation, not as the foreign key violation of an insert.
    expect(refusal?.code).toBe('23001');
  });
});

describe('a grant keeps what was set when it was issued, whoever updates it', () => {
  const UPDATES: readonly (readonly [string, string])[] = [
    ['id', `id = gen_random_uuid()`],
    ['principal_type', `principal_type = 'VENDOR'`],
    ['principal_id', `principal_id = gen_random_uuid()`],
    ['purpose', `purpose = 'MFA_ENROLMENT'`],
    ['token_hash', `token_hash = decode(repeat('ab', 32), 'hex')`],
    ['issued_at', `issued_at = issued_at - interval '1 minute'`],
    ['expires_at', `expires_at = expires_at + interval '1 day'`],
    ['issued_by', `issued_by = gen_random_uuid()`],
    ['episode_id', `episode_id = gen_random_uuid()`],
    ['attestation_challenge_hash', `attestation_challenge_hash = decode(repeat('cd', 32), 'hex')`],
  ];

  // Break caught: a column that makes a grant what it is rewritten after the fact, so that a token, a purpose, an end or a principal is
  // changed under a grant that was issued for another. The guard holds the administrator too ("a trigger refuses a change by any login").
  it.each(UPDATES)('refuses a change of %s', async (_column, assignment) => {
    const row = await grant();

    const refusal = await refusalOf(`update setup_grant set ${assignment} where id = $1`, [row.id]);

    expect(refusal?.code).toBe('23514');
  });

  it('refuses a change of the lineage, which is written once, with the row', async () => {
    const principalId = randomUUID();
    const earlier = await grant({ principalId });
    await setGrantState(admin, earlier.id, 'SUPERSEDED');
    const later = await grant({ principalId, supersedesGrantId: earlier.id });
    const consumed = await grant({ principalId, purpose: 'MFA_REENROLMENT' });
    await setGrantState(admin, consumed.id, 'CONSUMED');
    const continuation = await grant({
      principalId,
      purpose: 'MFA_ENROLMENT',
      continuedFromGrantId: consumed.id,
    });
    const free = await grant({ principalId, purpose: 'BOOTSTRAP_SETUP' });

    for (const [id, assignment] of [
      [later.id, `supersedes_grant_id = null`],
      [later.id, `supersedes_grant_id = '${randomUUID()}'`],
      [continuation.id, `continued_from_grant_id = null`],
      [free.id, `supersedes_grant_id = '${earlier.id}'`],
      [free.id, `continued_from_grant_id = '${consumed.id}'`],
    ] as const) {
      const refusal = await refusalOf(`update setup_grant set ${assignment} where id = $1`, [id]);
      expect(refusal?.code, assignment).toBe('23514');
      expect(refusal?.message, assignment).toMatch(
        /keeps everything but its state and the moment it was consumed/,
      );
    }
  });
});

describe('a grant moves along the state machine of state-machines.md §19, whoever updates it', () => {
  // Break caught: a second consumption (the single-use rule), or a terminal grant given another state, which would resurrect it.
  it.each([['CONSUMED'], ['EXPIRED'], ['SUPERSEDED']])(
    'keeps %s as it ended, and never returns to PENDING',
    async (terminal) => {
      const row = await grant(
        terminal === 'EXPIRED' ? { issuedAt: ago(60), expiresAt: ago(30) } : {},
      );
      await setGrantState(admin, row.id, terminal as 'CONSUMED' | 'EXPIRED' | 'SUPERSEDED');

      // Every move to a state it is not in, back to PENDING included; a write that changes nothing is no move and is not refused.
      const moves = ['PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED']
        .filter((state) => state !== terminal)
        .map(
          (state) =>
            `state = '${state}', consumed_at = ${state === 'CONSUMED' ? 'clock_timestamp()' : 'null'}`,
        );
      if (terminal === 'CONSUMED') moves.push(`consumed_at = consumed_at + interval '1 second'`);
      for (const assignment of moves) {
        const refusal = await refusalOf(`update setup_grant set ${assignment} where id = $1`, [
          row.id,
        ]);
        expect(refusal?.code, `${terminal}: ${assignment}`).toBe('23514');
        expect(refusal?.message, `${terminal}: ${assignment}`).toMatch(
          /only a PENDING grant changes state/,
        );
      }
    },
  );

  // Break caught: a grant consumed after its expiry, which the application's own fresh-clock check would be the only guard against.
  it('is consumed while it has not expired, at the database’s time', async () => {
    const expired = await grant({ issuedAt: ago(60), expiresAt: ago(30) });

    const refusal = await refusalOf(
      `update setup_grant set state = 'CONSUMED', consumed_at = clock_timestamp() where id = $1`,
      [expired.id],
    );

    expect(refusal?.code).toBe('23514');
    expect(refusal?.message).toMatch(/consumed only while it has not expired/);
    // The refusal says what it is in a form the application can tell from every other refusal of the table (the audit of
    // 21 October 2026, A06): a consumption that lost a race with the clock is answered as the grant being unusable, and a check that
    // failed for any other reason is a defect and is not.
    expect(refusal?.detail).toBe('reason=GRANT_EXPIRED');
    await setGrantState(admin, (await grant({ purpose: 'BOOTSTRAP_SETUP' })).id, 'CONSUMED');
  });

  it('states no reason for any refusal but a consumption after the expiry', async () => {
    const live = await grant();
    const consumed = await grant();
    await setGrantState(admin, consumed.id, 'CONSUMED');

    for (const [statement, id] of [
      [`update setup_grant set state = 'EXPIRED' where id = $1`, live.id],
      [`update setup_grant set state = 'SUPERSEDED' where id = $1`, consumed.id],
      [`update setup_grant set purpose = 'MFA_ENROLMENT' where id = $1`, live.id],
    ] as const) {
      const refusal = await refusalOf(statement, [id]);
      expect(refusal?.code, statement).toBe('23514');
      expect(refusal?.detail, statement).toBeUndefined();
    }
  });

  // Break caught: a live grant marked EXPIRED (which would end a grant early and hide it from the retention reader), or the bootstrap
  // secret, which has no expiry and so can never expire.
  it('expires only once its expiry has passed, and BOOTSTRAP_SETUP never', async () => {
    const live = await grant();
    const bootstrap = await grant({ purpose: 'BOOTSTRAP_SETUP' });
    const lapsed = await grant({ issuedAt: ago(60), expiresAt: ago(30) });

    for (const id of [live.id, bootstrap.id]) {
      const refusal = await refusalOf(`update setup_grant set state = 'EXPIRED' where id = $1`, [
        id,
      ]);
      expect(refusal?.code).toBe('23514');
      expect(refusal?.message).toMatch(/expires only when its expiry has passed/);
    }
    await setGrantState(admin, lapsed.id, 'EXPIRED');
  });

  it('is superseded from PENDING, at any point of its life, and only from PENDING', async () => {
    const live = await grant();
    await setGrantState(admin, live.id, 'SUPERSEDED');
    const consumed = await grant();
    await setGrantState(admin, consumed.id, 'CONSUMED');

    const refusal = await refusalOf(`update setup_grant set state = 'SUPERSEDED' where id = $1`, [
      consumed.id,
    ]);

    expect(refusal?.code).toBe('23514');
    expect(refusal?.message).toMatch(/only a PENDING grant changes state/);
  });
});

describe('what each login reaches', () => {
  const owner = randomUUID();
  let pending: GrantRow;
  let bootstrapGrant: GrantRow;

  const apiContext = systemContext('authentication');
  const asApi = <T>(
    ctx: SecurityContext,
    work: (tx: Parameters<Parameters<typeof withHandle>[2]>[1]) => Promise<T>,
  ): Promise<T> => withHandle(api.service, ctx, (_handle, tx) => work(tx));
  const refusal = async (action: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await action();
      return undefined;
    } catch (error) {
      return serverErrorIn(error)?.code;
    }
  };

  beforeAll(async () => {
    pending = await grant({ principalId: owner });
    bootstrapGrant = await grant({ purpose: 'BOOTSTRAP_SETUP' });
  });

  const visible = async (ctx: SecurityContext, service: BuiltService = api): Promise<string[]> =>
    withHandle(service.service, ctx, async (_handle, tx) => {
      const result = await tx.execute(
        sql`select id from setup_grant where id in (${pending.id}, ${bootstrapGrant.id}) order by id`,
      );
      return (result.rows as { id: string }[]).map((row) => row.id);
    });

  // Break caught: the pre-authentication path unable to find a grant, or any other capability or any human principal finding one.
  it('lets the authentication capability, and no other context, read a grant', async () => {
    expect(await visible(apiContext)).toEqual([pending.id, bootstrapGrant.id].toSorted());
    expect(await visible(systemContext('rate_limit'))).toEqual([]);
    expect(
      await visible({
        principalType: 'STAFF',
        principalId: owner,
        surface: 'OPS_PORTAL',
        correlationId: 'setup-grant-test',
      }),
    ).toEqual([]);
    expect(
      await visible({
        principalType: 'VENDOR',
        principalId: randomUUID(),
        surface: 'VENDOR_PWA',
        vendorOrganizationId: randomUUID(),
        correlationId: 'setup-grant-test',
      }),
    ).toEqual([]);
  });

  // Break caught: a human principal issuing or ending a grant, which only the authentication capability may do.
  it('refuses a grant to a human principal, whether it inserts one or consumes one', async () => {
    const human: SecurityContext = {
      principalType: 'STAFF',
      principalId: owner,
      surface: 'OPS_PORTAL',
      correlationId: 'setup-grant-test',
    };
    const insert = refusal(() =>
      asApi(human, (tx) =>
        tx.execute(sql`
          insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state)
          values (gen_random_uuid(), 'STAFF', ${owner}, 'STAFF_CREDENTIAL_SETUP', ${hashOf(randomUUID())}, now(), now() + interval '30 minutes', 'PENDING')`),
      ),
    );
    const consume = await asApi(human, async (tx) => {
      const result = await tx.execute(
        sql`update setup_grant set state = 'CONSUMED', consumed_at = clock_timestamp() where id = ${pending.id}`,
      );
      return result.rowCount ?? 0;
    });

    expect(await insert).toBe('42501');
    expect(consume).toBe(0);
  });

  // Break caught: the authentication capability unable to issue a grant, to consume it, or to supersede one.
  it('lets the authentication capability insert a grant and take it through the machine', async () => {
    const principalId = randomUUID();
    const first = grantRow({ principalId });
    const second = grantRow({ principalId, supersedesGrantId: first.id });
    await asApi(apiContext, async (tx) => {
      await tx.execute(sql`
        insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state)
        values (${first.id}, 'STAFF', ${principalId}, 'STAFF_CREDENTIAL_SETUP', ${first.tokenHash}, ${first.issuedAt}, ${first.expiresAt}, 'PENDING')`);
      await tx.execute(
        sql`update setup_grant set state = 'SUPERSEDED' where id = ${first.id} and state = 'PENDING'`,
      );
      await tx.execute(sql`
        insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, supersedes_grant_id)
        values (${second.id}, 'STAFF', ${principalId}, 'STAFF_CREDENTIAL_SETUP', ${second.tokenHash}, ${second.issuedAt}, ${second.expiresAt}, 'PENDING', ${first.id})`);
      await tx.execute(
        sql`update setup_grant set state = 'CONSUMED', consumed_at = clock_timestamp() where id = ${second.id}`,
      );
    });

    const stored = await admin.query(
      `select id, state from setup_grant where principal_id = $1 order by state`,
      [principalId],
    );
    expect(stored.rows).toEqual([
      { id: second.id, state: 'CONSUMED' },
      { id: first.id, state: 'SUPERSEDED' },
    ]);
  });

  // Break caught (the evidence of S0.29): "no UPDATE privilege exists on grant lineage". The API's login holds an UPDATE of exactly the
  // two columns a grant's life changes, never table-wide, and no DELETE.
  it('holds an UPDATE of the state and the moment of consumption and of nothing else, and no DELETE or TRUNCATE', async () => {
    const columns = await admin.query<{
      column: string;
      update: boolean;
      select: boolean;
      insert: boolean;
    }>(
      `select a.attname as column,
              has_column_privilege('melarc_api_runtime', c.oid, a.attnum, 'UPDATE') as update,
              has_column_privilege('melarc_api_runtime', c.oid, a.attnum, 'SELECT') as select,
              has_column_privilege('melarc_api_runtime', c.oid, a.attnum, 'INSERT') as insert
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relname = 'setup_grant' and c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    );

    expect(columns.rows.filter((column) => column.update).map((column) => column.column)).toEqual([
      'state',
      'consumed_at',
    ]);
    expect(columns.rows.every((column) => column.select && column.insert)).toBe(true);
    const table = await admin.query(
      `select has_table_privilege('melarc_api_runtime', 'setup_grant', 'DELETE') as "delete",
              has_table_privilege('melarc_api_runtime', 'setup_grant', 'TRUNCATE') as "truncate",
              has_table_privilege('melarc_api_runtime', 'setup_grant', 'UPDATE') as "tableUpdate"`,
    );
    expect(table.rows[0]).toEqual({ delete: false, truncate: false, tableUpdate: false });
  });

  // Break caught: a request rewriting the lineage, the token, the purpose or the end past the guard, through a grant it should not have.
  it('refuses the API’s login an update of any other column, with the privilege error and not the guard’s', async () => {
    const attempt = (statement: ReturnType<typeof sql>): Promise<string | undefined> =>
      refusal(() => asApi(apiContext, (tx) => tx.execute(statement)));

    for (const assignment of [
      sql`episode_id = gen_random_uuid()`,
      sql`supersedes_grant_id = gen_random_uuid()`,
      sql`continued_from_grant_id = gen_random_uuid()`,
      sql`issued_by = gen_random_uuid()`,
      sql`expires_at = expires_at + interval '1 day'`,
      sql`purpose = 'MFA_ENROLMENT'`,
      sql`principal_id = gen_random_uuid()`,
      sql`token_hash = ${hashOf('another')}`,
    ]) {
      expect(
        await attempt(sql`update setup_grant set ${assignment} where id = ${pending.id}`),
      ).toBe('42501');
    }
    expect(await attempt(sql`delete from setup_grant where id = ${pending.id}`)).toBe('42501');
  });

  // Break caught (the registry: the worker reads "state and expiry only, never the hash"): the worker able to read the token hash, the
  // principal or the lineage of a grant, or to change one, or any other capability of the worker reading one.
  it('lets the delivery worker read the identity, state and expiry of a grant, and nothing else', async () => {
    const worker = systemContext('credential_delivery');
    const read = (columns: string) =>
      refusal(() =>
        withHandle(work.service, worker, (_handle, tx) =>
          tx.execute(sql.raw(`select ${columns} from setup_grant where id = '${pending.id}'`)),
        ),
      );

    expect(await read('id, state, expires_at')).toBeUndefined();
    expect(await read('token_hash')).toBe('42501');
    expect(await read('principal_id')).toBe('42501');
    expect(await read('purpose')).toBe('42501');
    expect(await read('supersedes_grant_id')).toBe('42501');
    expect(await read('*')).toBe('42501');
    expect(
      await refusal(() =>
        withHandle(work.service, worker, (_handle, tx) =>
          tx.execute(sql`update setup_grant set state = 'CONSUMED' where id = ${pending.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await refusal(() =>
        withHandle(work.service, worker, (_handle, tx) =>
          tx.execute(sql`delete from setup_grant where id = ${pending.id}`),
        ),
      ),
    ).toBe('42501');

    const seen = async (ctx: SecurityContext): Promise<number> =>
      withHandle(work.service, ctx, async (_handle, tx) => {
        const result = await tx.execute(sql`select id from setup_grant where id = ${pending.id}`);
        return result.rows.length;
      });
    expect(await seen(worker)).toBe(1);
  });
});
