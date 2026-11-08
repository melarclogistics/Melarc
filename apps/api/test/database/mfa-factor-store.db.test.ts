import { randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { Sha256TokenService } from '../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import {
  MfaFactorContextError,
  MfaFactorRequestError,
} from '../../src/platform/auth/mfa/mfa-factor-errors.js';
import {
  MfaFactorStore,
  type CreateFactorRequest,
} from '../../src/platform/auth/mfa/mfa-factor-store.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { SetupGrantStore } from '../../src/platform/auth/setup-grants/setup-grant-store.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { SettingsReader } from '../../src/platform/settings/settings-reader.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { withHandle } from './support/handle.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.29, the store of MFA factors (`platform/auth/mfa/`), against a real PostgreSQL as the API's login under the authentication
 * capability: a factor is created `PENDING` with its seed sealed to the row, activated when a code has been proven (which revokes
 * the factor it replaces), revoked by the system or by an administrator (the one legal write of the revocation episode), and its
 * accepted time step is recorded with the replay rule. No operation calls it yet; `resetStaffMfa` is S0.37's.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let store: MfaFactorStore;
let grants: SetupGrantStore;
const cipher = new AesGcmSecretCipher(localKeys());
const tokens = new Sha256TokenService();

const authentication = systemContext('authentication');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 6 });
  const clock = new SystemClock();
  store = new MfaFactorStore({ cipher, clock });
  grants = new SetupGrantStore({
    tokens,
    queue: new PostgresDeliveryQueue({ cipher, clock }),
    settings: new SettingsReader(),
    clock,
  });
});

afterAll(async () => {
  await admin.end();
  await api.close();
  await database.drop();
});

const inTransaction = <T>(
  action: (handle: TransactionHandle) => Promise<T>,
  context = authentication,
): Promise<T> => withHandle(api.service, context, (handle) => action(handle));

const identity = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));

/** A seed that is easy to find in a dump: its hex and its base64 are what the checks below look for. */
const SENTINEL_SEED = Buffer.from('53454e54494e454c2d544f54502d53454544', 'hex'); // "SENTINEL-TOTP-SEED"

const create = (request: Omit<CreateFactorRequest, 'seed'> & { seed?: Uint8Array }) =>
  inTransaction((handle) => store.create(handle, { seed: randomBytes(20), ...request }));

async function createFor(owner: StaffRow, over: Partial<CreateFactorRequest> = {}) {
  return create({ staffIdentityId: owner.id, createdByPurpose: 'STAFF_CREDENTIAL_SETUP', ...over });
}

const rowOf = async (id: string) =>
  (await admin.query(`select * from mfa_factor where id = $1`, [id])).rows[0] as
    Record<string, unknown> | undefined;

describe('creating a factor', () => {
  // Break caught (§6.8: "Encrypted, not hashed ... never persisted or logged in plaintext"): a seed stored as given, or a factor that
  // is not PENDING (a factor grants nothing until a code has been proven).
  it('creates a PENDING factor whose seed is sealed, and opens it again from the row', async () => {
    const owner = await identity();

    const factor = await create({
      staffIdentityId: owner.id,
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
      seed: SENTINEL_SEED,
    });

    expect(factor).toMatchObject({
      staffIdentityId: owner.id,
      factorType: 'TOTP',
      status: 'PENDING',
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
      createdEpisodeId: null,
      enrolledAt: null,
      revokedAt: null,
      lastVerifiedCounter: null,
      revokedBy: null,
    });
    const row = await rowOf(factor.id);
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(SENTINEL_SEED.toString('hex'));
    expect(dump).not.toContain(SENTINEL_SEED.toString('base64'));
    expect(row?.secret_envelope_version).toBe(1);
    expect(row?.secret_key_version).toBe(1);
    expect(Buffer.from(row?.secret_ciphertext as Buffer).includes(SENTINEL_SEED)).toBe(false);
    const opened = await inTransaction((handle) => store.openSeed(handle, factor.id));
    expect(Buffer.from(opened ?? new Uint8Array(0)).equals(SENTINEL_SEED)).toBe(true);
    // What the store returns holds no part of the secret.
    expect(Object.keys(factor).filter((key) => /secret|seed|cipher|nonce/i.test(key))).toEqual([]);
  });

  // Break caught (OB-39: "builds its context with sealedContext() from the record and never from the request"): a ciphertext that
  // opens for another row, so that a copy of one factor's secret into another would produce a working second factor.
  it('opens a seed only for the row it was sealed for, even within one identity', async () => {
    // Two factors of the SAME identity, so that the identity cannot be what tells them apart: only the row's own id can.
    const owner = await identity();
    const first = await createFor(owner, {});
    const second = await createFor(owner, {});
    // Arranged as the administrator: no login of the application can write these columns after the insert.
    await admin.query(
      `update mfa_factor set secret_ciphertext = (select secret_ciphertext from mfa_factor where id = $1),
                             secret_nonce = (select secret_nonce from mfa_factor where id = $1)
        where id = $2`,
      [first.id, second.id],
    );

    await expect(
      inTransaction((handle) => store.openSeed(handle, second.id)),
    ).rejects.toMatchObject({ condition: 'AUTHENTICATION_FAILED' });
    expect(await inTransaction((handle) => store.openSeed(handle, first.id))).toBeInstanceOf(
      Uint8Array,
    );
  });

  // Break caught (OB-39): a seed that opens for the same row under another identity, so that a factor moved to another person would
  // keep working. The identity is part of the context as well as the row.
  it('opens a seed only for the identity it was sealed for', async () => {
    const factor = await createFor(await identity(), {});
    const stranger = await identity();
    expect(await inTransaction((handle) => store.openSeed(handle, factor.id))).toBeInstanceOf(
      Uint8Array,
    );
    // No login of the application can move a factor; arranged as the administrator, past the guard that forbids it.
    await admin.query('alter table mfa_factor disable trigger mfa_factor_update_guard');
    try {
      await admin.query(`update mfa_factor set staff_identity_id = $2 where id = $1`, [
        factor.id,
        stranger.id,
      ]);
    } finally {
      await admin.query('alter table mfa_factor enable trigger mfa_factor_update_guard');
    }

    await expect(
      inTransaction((handle) => store.openSeed(handle, factor.id)),
    ).rejects.toMatchObject({
      condition: 'AUTHENTICATION_FAILED',
    });
  });

  it('opens nothing for a factor that was revoked, or that does not exist', async () => {
    const factor = await createFor(await identity());
    await inTransaction((handle) => store.revokeBySystem(handle, factor.id));

    expect(await inTransaction((handle) => store.openSeed(handle, factor.id))).toBeNull();
    expect(await inTransaction((handle) => store.openSeed(handle, randomUUID()))).toBeNull();
  });

  // Break caught: a re-enrolment factor with no episode on its row, or an episode that belongs to no grant of the identity.
  it('records the episode of a re-enrolment, and holds it to a grant of the same identity at commit', async () => {
    const owner = await identity();
    const episodeId = randomUUID();
    await inTransaction((handle) =>
      grants.issue(handle, {
        principal: { type: 'STAFF', id: owner.id },
        purpose: 'MFA_REENROLMENT',
        episodeId,
      }),
    );

    const factor = await createFor(owner, {
      createdByPurpose: 'MFA_REENROLMENT',
      createdEpisodeId: episodeId,
    });

    expect(factor.createdEpisodeId).toBe(episodeId);
    const stranger = await identity();
    const failure = await createFor(stranger, {
      createdByPurpose: 'MFA_REENROLMENT',
      createdEpisodeId: episodeId,
    }).catch((error: unknown) => serverErrorIn(error)?.code);
    expect(failure).toBe('23503');
  });

  // Break caught: a request the database would refuse reaching it, or accept that the machine does not allow.
  it.each([
    [
      'an identity that is not an id',
      { staffIdentityId: 'nobody', createdByPurpose: 'STAFF_CREDENTIAL_SETUP' },
    ],
    [
      'a purpose that creates no factor (MFA_ENROLMENT activates one)',
      { staffIdentityId: randomUUID(), createdByPurpose: 'MFA_ENROLMENT' },
    ],
    [
      'a rider purpose',
      { staffIdentityId: randomUUID(), createdByPurpose: 'RIDER_DEVICE_ENROLMENT' },
    ],
    [
      'an episode on a factor an onboarding creates',
      {
        staffIdentityId: randomUUID(),
        createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
        createdEpisodeId: randomUUID(),
      },
    ],
    [
      'an episode that is not an id',
      { staffIdentityId: randomUUID(), createdByPurpose: 'MFA_REENROLMENT', createdEpisodeId: 'e' },
    ],
    [
      'no seed',
      {
        staffIdentityId: randomUUID(),
        createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
        seed: new Uint8Array(0),
      },
    ],
    [
      'a seed that is not bytes',
      { staffIdentityId: randomUUID(), createdByPurpose: 'STAFF_CREDENTIAL_SETUP', seed: 'text' },
    ],
  ] as const)('refuses %s before it writes anything', async (_label, request) => {
    const before = (await admin.query(`select count(*)::int as n from mfa_factor`)).rows[0] as {
      n: number;
    };

    await expect(create(request as unknown as CreateFactorRequest)).rejects.toBeInstanceOf(
      MfaFactorRequestError,
    );

    expect((await admin.query(`select count(*)::int as n from mfa_factor`)).rows[0]).toEqual(
      before,
    );
  });

  it('refuses an identity that does not exist, whole', async () => {
    const failure = await create({
      staffIdentityId: randomUUID(),
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
    }).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    // The foreign key to the identity refuses it, and nothing else does.
    expect(serverErrorIn(failure)).toMatchObject({
      code: '23503',
      constraint: 'mfa_factor_staff_identity_fkey',
    });
  });

  // Break caught: a factor that survives the rollback of the act that created it.
  it('rolls back with the transaction that created it', async () => {
    const owner = await identity();

    await expect(
      inTransaction(async (handle) => {
        await store.create(handle, {
          staffIdentityId: owner.id,
          createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
          seed: randomBytes(20),
        });
        throw new Error('the act failed afterwards');
      }),
    ).rejects.toThrow('the act failed afterwards');

    expect(
      (
        await admin.query(
          `select count(*)::int as n from mfa_factor where staff_identity_id = $1`,
          [owner.id],
        )
      ).rows[0],
    ).toEqual({ n: 0 });
  });
});

describe('proving a factor: PENDING to ACTIVE', () => {
  // Break caught (§18: "PENDING to ACTIVE ... when a generated code has been successfully proven"): an activation with no moment, or
  // with no step recorded, which would let the very code that proved it be accepted again.
  it('activates a PENDING factor at the database’s time and records the step that proved it', async () => {
    const owner = await identity();
    const factor = await createFor(owner);

    const activated = await inTransaction((handle) =>
      store.activate(handle, factor.id, '59000000'),
    );

    expect(activated?.factor).toMatchObject({
      id: factor.id,
      status: 'ACTIVE',
      lastVerifiedCounter: '59000000',
    });
    expect(activated?.factor.enrolledAt).toBeInstanceOf(Date);
    expect(Math.abs((activated?.factor.enrolledAt?.getTime() ?? 0) - Date.now())).toBeLessThan(
      10_000,
    );
    expect(activated?.replacedFactorIds).toEqual([]);
  });

  // Break caught (§6.8: "Enrolling a replacement revokes the previous one"; "at most one ACTIVE factor"): two proven factors, or the
  // earlier one left usable.
  it('revokes the identity’s earlier ACTIVE factor, with no administrator, in the same transaction', async () => {
    const owner = await identity();
    const first = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, first.id, '100'));
    const second = await createFor(owner);

    const activated = await inTransaction((handle) => store.activate(handle, second.id, '200'));

    expect(activated?.replacedFactorIds).toEqual([first.id]);
    expect(await rowOf(first.id)).toMatchObject({
      status: 'REVOKED',
      revoked_by: null,
      revocation_reason_code: null,
      revocation_episode_id: null,
    });
    expect(await rowOf(second.id)).toMatchObject({ status: 'ACTIVE' });
  });

  // Break caught: an activation that revokes the earlier factor and then finds nothing to activate, leaving the identity with none.
  it('activates nothing, and revokes nothing, for a factor that is not PENDING or does not exist', async () => {
    const owner = await identity();
    const first = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, first.id, '100'));

    expect(await inTransaction((handle) => store.activate(handle, first.id, '300'))).toBeNull();
    expect(await inTransaction((handle) => store.activate(handle, randomUUID(), '300'))).toBeNull();
    const revoked = await createFor(owner);
    await inTransaction((handle) => store.revokeBySystem(handle, revoked.id));
    expect(await inTransaction((handle) => store.activate(handle, revoked.id, '300'))).toBeNull();

    expect(await rowOf(first.id)).toMatchObject({ status: 'ACTIVE', last_verified_counter: '100' });
  });

  // Break caught: two enrolments that finish together leaving two ACTIVE factors, or one of them failing on the unique index instead of
  // waiting its turn.
  it('leaves exactly one ACTIVE factor when two of an identity are proven together', async () => {
    const owner = await identity();
    const [a, b, c] = await Promise.all([createFor(owner), createFor(owner), createFor(owner)]);

    const results = await Promise.all(
      [a, b, c].map((factor, at) =>
        inTransaction((handle) => store.activate(handle, factor.id, String(1000 + at))),
      ),
    );

    expect(results.every((result) => result !== null)).toBe(true);
    const states = (
      await admin.query(
        `select status, count(*)::int as n from mfa_factor where staff_identity_id = $1 group by status`,
        [owner.id],
      )
    ).rows;
    expect(
      Object.fromEntries(states.map((row: { status: string; n: number }) => [row.status, row.n])),
    ).toEqual({ ACTIVE: 1, REVOKED: 2 });
  });

  it.each([['01'], ['-1'], ['1.5'], [''], ['x'], ['9'.repeat(20)]])(
    'refuses a step written as %j',
    async (step) => {
      const factor = await createFor(await identity());

      await expect(
        inTransaction((handle) => store.activate(handle, factor.id, step)),
      ).rejects.toBeInstanceOf(MfaFactorRequestError);
    },
  );
});

describe('the accepted time step (replay protection)', () => {
  const record = (factorId: string, step: string) =>
    inTransaction((handle) => store.recordAcceptedStep(handle, factorId, step));

  async function activeFactor(step = '100') {
    const factor = await createFor(await identity());
    await inTransaction((handle) => store.activate(handle, factor.id, step));
    return factor;
  }

  // Break caught (§6.8: "a code may not be accepted twice within its window"): the same step accepted again, or an earlier one.
  it('accepts a later step, and refuses the same one and any earlier one', async () => {
    const factor = await activeFactor('100');

    expect(await record(factor.id, '101')).toBe(true);
    expect(await record(factor.id, '101')).toBe(false);
    expect(await record(factor.id, '100')).toBe(false);
    expect(await record(factor.id, '5')).toBe(false);
    expect(await record(factor.id, '102')).toBe(true);
    expect((await rowOf(factor.id))?.last_verified_counter).toBe('102');
  });

  // Break caught: two requests that present one code together both being accepted, the check and the write apart.
  it('accepts one of two requests that present the same step together', async () => {
    const factor = await activeFactor('100');

    const results = await Promise.all(Array.from({ length: 5 }, () => record(factor.id, '500')));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('records a step for an ACTIVE factor only', async () => {
    const pending = await createFor(await identity());
    const revoked = await activeFactor();
    await inTransaction((handle) => store.revokeBySystem(handle, revoked.id));

    expect(await record(pending.id, '900')).toBe(false);
    expect(await record(revoked.id, '900')).toBe(false);
    expect(await record(randomUUID(), '900')).toBe(false);
  });
});

describe('revoking a factor', () => {
  // Break caught (§18: "→ REVOKED ... System ... retained as history"): a revocation that deletes, or that names an administrator.
  it('revokes a PENDING or an ACTIVE factor by the system, once, keeping the row', async () => {
    const owner = await identity();
    const pending = await createFor(owner);
    const active = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, active.id, '10'));

    const first = await inTransaction((handle) => store.revokeBySystem(handle, pending.id));
    const second = await inTransaction((handle) => store.revokeBySystem(handle, active.id));
    const again = await inTransaction((handle) => store.revokeBySystem(handle, pending.id));

    expect(first).toMatchObject({ status: 'REVOKED', revokedBy: null, revocationEpisodeId: null });
    expect(first?.revokedAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ status: 'REVOKED' });
    expect(again).toBeNull();
    expect(await rowOf(pending.id)).toBeDefined();
  });

  // Break caught (§6.8: the one legal write of `revocation_episode_id`): the valid reset write refused to the store, or written
  // without the administrator, the reason and the episode together.
  it('revokes administratively with the administrator, the reason and the episode of the reset, in the reset’s transaction', async () => {
    const owner = await identity();
    const administrator = await identity();
    const factor = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, factor.id, '10'));
    const episodeId = randomUUID();

    const revoked = await inTransaction(async (handle) => {
      const result = await store.revokeAdministratively(handle, {
        factorId: factor.id,
        administratorId: administrator.id,
        reasonCode: 'MFA_AUTHENTICATOR_UNAVAILABLE',
        episodeId,
      });
      // The reset issues its re-enrolment grant of the same episode in the same transaction.
      await grants.issue(handle, {
        principal: { type: 'STAFF', id: owner.id },
        purpose: 'MFA_REENROLMENT',
        episodeId,
        issuedBy: administrator.id,
      });
      return result;
    });

    expect(revoked).toMatchObject({
      status: 'REVOKED',
      revokedBy: administrator.id,
      revocationReasonCode: 'MFA_AUTHENTICATOR_UNAVAILABLE',
      revocationEpisodeId: episodeId,
    });
  });

  it('answers null for a factor already revoked, and changes nothing', async () => {
    const owner = await identity();
    const administrator = await identity();
    const factor = await createFor(owner);
    await inTransaction((handle) => store.revokeBySystem(handle, factor.id));

    const result = await inTransaction((handle) =>
      store.revokeAdministratively(handle, {
        factorId: factor.id,
        administratorId: administrator.id,
        reasonCode: 'MFA_ENROLMENT_EXPIRED',
        episodeId: randomUUID(),
      }),
    );

    expect(result).toBeNull();
    expect(await rowOf(factor.id)).toMatchObject({ revoked_by: null, revocation_episode_id: null });
  });

  // Break caught: an episode of another identity's grants, or none, accepted by the store and left to nobody; the deferred constraint is
  // the database's, and the store lets it speak.
  it('fails at commit when the episode belongs to no grant of the identity', async () => {
    const owner = await identity();
    const administrator = await identity();
    const factor = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, factor.id, '10'));

    const code = await inTransaction((handle) =>
      store.revokeAdministratively(handle, {
        factorId: factor.id,
        administratorId: administrator.id,
        reasonCode: 'MFA_AUTHENTICATOR_UNAVAILABLE',
        episodeId: randomUUID(),
      }),
    ).catch((error: unknown) => serverErrorIn(error)?.code);

    expect(code).toBe('23503');
    expect((await rowOf(factor.id))?.status).toBe('ACTIVE');
  });

  it('refuses an administrator who is the identity itself', async () => {
    const owner = await identity();
    const factor = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, factor.id, '10'));
    const episodeId = randomUUID();

    const code = await inTransaction(async (handle) => {
      await grants.issue(handle, {
        principal: { type: 'STAFF', id: owner.id },
        purpose: 'MFA_REENROLMENT',
        episodeId,
      });
      return store.revokeAdministratively(handle, {
        factorId: factor.id,
        administratorId: owner.id,
        reasonCode: 'MFA_AUTHENTICATOR_UNAVAILABLE',
        episodeId,
      });
    }).catch((error: unknown) => serverErrorIn(error)?.code);

    expect(code).toBe('23514');
  });

  it.each([
    [
      'a factor that is not an id',
      { factorId: 'f', administratorId: randomUUID(), reasonCode: 'R', episodeId: randomUUID() },
    ],
    [
      'an administrator that is not an id',
      { factorId: randomUUID(), administratorId: 'a', reasonCode: 'R', episodeId: randomUUID() },
    ],
    [
      'an episode that is not an id',
      { factorId: randomUUID(), administratorId: randomUUID(), reasonCode: 'R', episodeId: 'e' },
    ],
    [
      'no reason',
      {
        factorId: randomUUID(),
        administratorId: randomUUID(),
        reasonCode: '  ',
        episodeId: randomUUID(),
      },
    ],
    [
      'a reason that is not text',
      {
        factorId: randomUUID(),
        administratorId: randomUUID(),
        reasonCode: 7,
        episodeId: randomUUID(),
      },
    ],
  ])('refuses %s', async (_label, request) => {
    await expect(
      inTransaction((handle) => store.revokeAdministratively(handle, request as never)),
    ).rejects.toBeInstanceOf(MfaFactorRequestError);
  });
});

describe('reading a factor', () => {
  // Break caught (GBT-E5, the port half: "by-key lookups and no list or scan method").
  it('has lookups by the key a request presents and no list or scan', () => {
    const methods = Object.getOwnPropertyNames(MfaFactorStore.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(methods.toSorted()).toEqual([
      'activate',
      'create',
      'findActiveOf',
      'findById',
      'findLatestOf',
      'findPendingOf',
      'hasBeenProven',
      'openSeed',
      'recordAcceptedStep',
      'revokeAdministratively',
      'revokeBySystem',
    ]);
    for (const name of methods)
      expect(name).not.toMatch(/^(list|all|scan|search|query|each|every|export)/i);
  });

  // Break caught: "the factor" of an identity ambiguous, or the latest read as the active one.
  it('finds the ACTIVE factor of an identity, and its most recent factor, by identity', async () => {
    const owner = await identity();
    const first = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, first.id, '10'));
    const second = await createFor(owner);

    const active = await inTransaction((handle) => store.findActiveOf(handle, owner.id));
    const latest = await inTransaction((handle) => store.findLatestOf(handle, owner.id));
    const byId = await inTransaction((handle) => store.findById(handle, first.id));

    expect(active?.id).toBe(first.id);
    expect(latest?.id).toBe(second.id);
    expect(byId).toEqual(active);
    expect(await inTransaction((handle) => store.findActiveOf(handle, randomUUID()))).toBeNull();
    expect(await inTransaction((handle) => store.findLatestOf(handle, randomUUID()))).toBeNull();
    expect(await inTransaction((handle) => store.findById(handle, randomUUID()))).toBeNull();
    await expect(inTransaction((handle) => store.findById(handle, 'x'))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('reading what an enrolment needs (S0.31)', () => {
  // Break caught: a re-enrolment that supersedes a factor that is not unusable (an ACTIVE or an already revoked one), or misses one.
  it('finds the PENDING factors of an identity, oldest first, and no other', async () => {
    const owner = await identity();
    const other = await identity();
    const active = await createFor(owner);
    await inTransaction((handle) => store.activate(handle, active.id, '10'));
    const revoked = await createFor(owner);
    await inTransaction((handle) => store.revokeBySystem(handle, revoked.id));
    const first = await createFor(owner);
    const second = await createFor(owner);
    await createFor(other);

    const pending = await inTransaction((handle) => store.findPendingOf(handle, owner.id));

    expect(pending.map((factor) => factor.id)).toEqual([first.id, second.id]);
    expect(pending.every((factor) => factor.status === 'PENDING')).toBe(true);
    expect(await inTransaction((handle) => store.findPendingOf(handle, randomUUID()))).toEqual([]);
    await expect(
      inTransaction((handle) => store.findPendingOf(handle, 'x')),
    ).rejects.toBeInstanceOf(TypeError);
  });

  // Break caught: the first proof of an identity taken from the factor now ACTIVE, so that an identity whose factor was reset and
  // proven again looks as if it had never been proven (the bootstrap's completion is recorded once, at the first proof only).
  it('says whether a factor of the identity was ever proven, though it has since been revoked', async () => {
    const owner = await identity();
    const other = await identity();
    const pending = await createFor(owner);
    expect(await inTransaction((handle) => store.hasBeenProven(handle, owner.id))).toBe(false);

    await inTransaction((handle) => store.activate(handle, pending.id, '10'));
    expect(await inTransaction((handle) => store.hasBeenProven(handle, owner.id))).toBe(true);

    await inTransaction((handle) => store.revokeBySystem(handle, pending.id));
    await createFor(owner);
    expect(await inTransaction((handle) => store.hasBeenProven(handle, owner.id))).toBe(true);

    await createFor(other);
    expect(await inTransaction((handle) => store.hasBeenProven(handle, other.id))).toBe(false);
    expect(await inTransaction((handle) => store.hasBeenProven(handle, randomUUID()))).toBe(false);
    await expect(
      inTransaction((handle) => store.hasBeenProven(handle, 'x')),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('where the store may run', () => {
  // Break caught: a factor read or written under a context the policy would silently hide its effects from, which reads as "no factor"
  // and not as a refusal.
  it('refuses a transaction that is not the authentication capability’s, before it touches a table', async () => {
    const wrong = [
      systemContext('rate_limit'),
      {
        principalType: 'STAFF',
        principalId: randomUUID(),
        surface: 'OPS_PORTAL',
        correlationId: 'store-test',
      } as const,
    ];

    // Every method the store has, so that a method added without the check is a method this test names.
    const calls: readonly (readonly [string, (handle: TransactionHandle) => Promise<unknown>])[] = [
      [
        'create',
        (handle) =>
          store.create(handle, {
            staffIdentityId: randomUUID(),
            createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
            seed: randomBytes(20),
          }),
      ],
      ['openSeed', (handle) => store.openSeed(handle, randomUUID())],
      ['activate', (handle) => store.activate(handle, randomUUID(), '5')],
      ['recordAcceptedStep', (handle) => store.recordAcceptedStep(handle, randomUUID(), '5')],
      ['revokeBySystem', (handle) => store.revokeBySystem(handle, randomUUID())],
      [
        'revokeAdministratively',
        (handle) =>
          store.revokeAdministratively(handle, {
            factorId: randomUUID(),
            administratorId: randomUUID(),
            reasonCode: 'MFA_AUTHENTICATOR_UNAVAILABLE',
            episodeId: randomUUID(),
          }),
      ],
      ['findById', (handle) => store.findById(handle, randomUUID())],
      ['findActiveOf', (handle) => store.findActiveOf(handle, randomUUID())],
      ['findLatestOf', (handle) => store.findLatestOf(handle, randomUUID())],
      ['findPendingOf', (handle) => store.findPendingOf(handle, randomUUID())],
      ['hasBeenProven', (handle) => store.hasBeenProven(handle, randomUUID())],
    ];
    const named = Object.getOwnPropertyNames(MfaFactorStore.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(calls.map(([name]) => name).toSorted()).toEqual(named.toSorted());

    for (const context of wrong) {
      for (const [name, call] of calls) {
        await expect(
          inTransaction((handle) => call(handle), context),
          name,
        ).rejects.toBeInstanceOf(MfaFactorContextError);
      }
    }
  });
});

describe('secrets', () => {
  // Break caught (plan section 3, "Secrets"): a seed in an error, a log line or a returned object.
  it('puts no seed in an error that a refusal raises or in what the pool logged', async () => {
    const owner = await identity();
    const factor = await create({
      staffIdentityId: owner.id,
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
      seed: SENTINEL_SEED,
    });
    const failure = await create({
      staffIdentityId: 'nobody',
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
      seed: SENTINEL_SEED,
    }).catch((error: unknown) => error);

    for (const text of [
      JSON.stringify(failure),
      (failure as Error).message,
      api.logs.text(),
      JSON.stringify(factor),
    ]) {
      expect(text).not.toContain(SENTINEL_SEED.toString('hex'));
      expect(text).not.toContain(SENTINEL_SEED.toString('base64'));
    }
  });
});
