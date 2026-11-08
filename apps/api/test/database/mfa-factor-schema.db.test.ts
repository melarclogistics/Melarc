import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FACTOR_COUNTER_PATTERN,
  FACTOR_CREATED_BY_PURPOSES,
  FACTOR_STATUSES,
  FACTOR_TYPES,
  SEALED_NONCE_BYTES,
  SEALED_TAG_BYTES,
} from '../../src/platform/auth/mfa/mfa-vocabulary.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
  setGrantState,
  type FactorRow,
  type GrantRow,
} from './support/credentials.js';
import { withHandle } from './support/handle.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.29, the MFA factor (migration 0018, `mfa_factor`), against a real PostgreSQL: what the schema itself refuses (tried as the
 * administrator), and `GBT-B14`, constraint half, as the API's login under the authentication capability: the valid write of a
 * revocation episode and each illegal one (state-machines.md §18; domain-model.md §6.8 `MfaFactor`). The behaviour half of `GBT-B14`
 * (`resetStaffMfa` against each recorded state) is S0.37's, because the operation does not exist yet.
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
}

const refusalFrom = (error: unknown): Refusal => {
  const { code, constraint, message } = error as {
    code?: string;
    constraint?: string;
    message?: string;
  };
  return { code, constraint, message: message ?? '' };
};

/** What the database said to a statement, or `undefined` when it ran. */
async function refusalOf(statement: string, values: unknown[] = []): Promise<Refusal | undefined> {
  try {
    await admin.query(statement, values);
    return undefined;
  } catch (error) {
    return refusalFrom(error);
  }
}

const refusalOfInsert = async (row: FactorRow): Promise<Refusal | undefined> => {
  try {
    await insertFactor(admin, row);
    return undefined;
  } catch (error) {
    return refusalFrom(error);
  }
};

const identity = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const factorOf = (
  staffIdentityId: string,
  overrides: Partial<FactorRow> = {},
): Promise<FactorRow> => insertFactor(admin, factorRow(staffIdentityId, overrides));
const grant = (overrides: Partial<GrantRow> = {}): Promise<GrantRow> =>
  insertGrant(admin, grantRow(overrides));

/** An identity with a proven factor. */
async function withActiveFactor(): Promise<{ identity: StaffRow; factor: FactorRow }> {
  const owner = await identity();
  const factor = await factorOf(owner.id);
  await activateFactor(admin, factor.id);
  return { identity: owner, factor };
}

/** The statement of an administrative revocation of `factor` by `actor`, into `episode`. */
const revoke = (
  factorId: string,
  actor: string,
  episode: string | null,
): Promise<Refusal | undefined> =>
  refusalOf(
    `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp(), revoked_by = $2,
                           revocation_reason_code = 'MFA_AUTHENTICATOR_UNAVAILABLE', revocation_episode_id = $3
      where id = $1`,
    [factorId, actor, episode],
  );

const stateOf = async (id: string): Promise<Record<string, unknown> | undefined> =>
  (await admin.query(`select * from mfa_factor where id = $1`, [id])).rows[0] as
    Record<string, unknown> | undefined;

const factorConstraint = async (name: string): Promise<string> =>
  (
    await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint where conname = $1 and conrelid = 'public.mfa_factor'::regclass`,
      [name],
    )
  ).rows[0]?.definition ?? '';
const quotedWords = (definition: string): string[] =>
  [
    ...new Set((definition.match(/'[A-Za-z_]+'/g) ?? []).map((word) => word.slice(1, -1))),
  ].toSorted();

describe('the table repeats the closed sets of the code (mfa-vocabulary.ts), and a change to one fails here', () => {
  it.each([
    ['mfa_factor_type_closed', FACTOR_TYPES],
    ['mfa_factor_status_closed', FACTOR_STATUSES],
    ['mfa_factor_purpose_closed', FACTOR_CREATED_BY_PURPOSES],
  ])('holds the set of %s', async (name, expected) => {
    expect(quotedWords(await factorConstraint(name))).toEqual([...expected].toSorted());
  });

  // Break caught: the envelope the table accepts drifting from the one the cipher makes (a 96-bit nonce, a 16-byte tag).
  it('accepts the envelope the cipher makes: a nonce of its length and a ciphertext longer than its tag', async () => {
    const definition = await factorConstraint('mfa_factor_secret_whole');

    expect(definition).toContain(`octet_length(secret_nonce) = ${String(SEALED_NONCE_BYTES)}`);
    expect(definition).toContain(`octet_length(secret_ciphertext) > ${String(SEALED_TAG_BYTES)}`);
  });

  it('holds the step of a code in the form the code writes it', async () => {
    const definition = await factorConstraint('mfa_factor_counter_shape');

    expect(definition).toContain(FACTOR_COUNTER_PATTERN.source);
  });
});

describe('a factor is held to the rules of the domain model', () => {
  // Break caught (§6.8): a factor type that is not TOTP (SMS is deliberately not a privileged factor), a purpose that creates none, or a
  // status the machine does not have.
  it('is a TOTP factor created by one of the three creating purposes, in one of the three statuses', async () => {
    const owner = await identity();

    expect((await refusalOfInsert(factorRow(owner.id, { factorType: 'SMS' })))?.constraint).toBe(
      'mfa_factor_type_closed',
    );
    for (const purpose of ['MFA_ENROLMENT', 'RIDER_DEVICE_ENROLMENT', 'VENDOR_CREDENTIAL_SETUP']) {
      expect(
        (await refusalOfInsert(factorRow(owner.id, { createdByPurpose: purpose })))?.constraint,
        purpose,
      ).toBe('mfa_factor_purpose_closed');
    }
    const row = await factorOf(owner.id);
    expect(
      (await refusalOf(`update mfa_factor set status = 'SUSPENDED' where id = $1`, [row.id]))
        ?.constraint,
    ).toBe('mfa_factor_status_closed');
    for (const purpose of ['STAFF_CREDENTIAL_SETUP', 'BOOTSTRAP_SETUP', 'MFA_REENROLMENT']) {
      await factorOf((await identity()).id, { createdByPurpose: purpose });
    }
  });

  // Break caught (§6.8 "Encrypted, not hashed"): a secret that is not a sealed envelope: no nonce, a nonce of another size, a ciphertext
  // shorter than its tag, or no version of the key or the layout it was sealed under.
  it('holds its secret as a sealed envelope: ciphertext, nonce, key version and envelope version', async () => {
    const owner = await identity();
    const refused = async (overrides: Partial<FactorRow>): Promise<string | undefined> =>
      (await refusalOfInsert(factorRow(owner.id, overrides)))?.constraint;

    expect(await refused({ secretNonce: Buffer.alloc(11, 1) })).toBe('mfa_factor_secret_whole');
    expect(await refused({ secretNonce: Buffer.alloc(13, 1) })).toBe('mfa_factor_secret_whole');
    expect(await refused({ secretCiphertext: Buffer.alloc(16, 1) })).toBe(
      'mfa_factor_secret_whole',
    );
    expect(await refused({ secretKeyVersion: 0 })).toBe('mfa_factor_secret_whole');
    expect(await refused({ secretEnvelopeVersion: 0 })).toBe('mfa_factor_secret_whole');
    expect(
      (
        await refusalOf(
          `insert into mfa_factor (id, staff_identity_id, factor_type, status, created_by_purpose)
           values (gen_random_uuid(), $1, 'TOTP', 'PENDING', 'STAFF_CREDENTIAL_SETUP')`,
          [owner.id],
        )
      )?.code,
    ).toBe('23502');
  });

  // Break caught (state-machines.md §18: every creating transition is `→ PENDING`): a factor born ACTIVE or REVOKED, which would be a
  // factor nobody proved, or a history that never happened.
  it('is created PENDING, whoever inserts it', async () => {
    const owner = await identity();
    for (const status of ['ACTIVE', 'REVOKED']) {
      const row = factorRow(owner.id);
      const refusal = await refusalOf(
        `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                                 secret_envelope_version, created_by_purpose, enrolled_at, revoked_at)
         values ($1, $2, 'TOTP', $3, $4, $5, 1, 1, 'STAFF_CREDENTIAL_SETUP', now(), case when $3 = 'REVOKED' then now() end)`,
        [row.id, owner.id, status, row.secretCiphertext, row.secretNonce],
      );
      expect(refusal?.code, status).toBe('23514');
      expect(refusal?.message, status).toMatch(/created PENDING/);
    }
  });

  // Break caught (§6.8: "enrolled_at: non-null from ACTIVE"): an ACTIVE factor with no enrolment moment, or a PENDING one that has one.
  it('has been enrolled exactly from the moment it is ACTIVE, and is revoked exactly when it is REVOKED', async () => {
    const owner = await identity();
    const pending = await factorOf(owner.id);

    expect(
      (await refusalOf(`update mfa_factor set status = 'ACTIVE' where id = $1`, [pending.id]))
        ?.constraint,
    ).toBe('mfa_factor_enrolment_follows_status');
    expect(
      (await refusalOf(`update mfa_factor set enrolled_at = now() where id = $1`, [pending.id]))
        ?.constraint,
    ).toBe('mfa_factor_enrolment_follows_status');
    expect(
      (await refusalOf(`update mfa_factor set status = 'REVOKED' where id = $1`, [pending.id]))
        ?.constraint,
    ).toBe('mfa_factor_revocation_follows_status');
    expect(
      (await refusalOf(`update mfa_factor set revoked_at = now() where id = $1`, [pending.id]))
        ?.constraint,
    ).toBe('mfa_factor_revocation_follows_status');
    await activateFactor(admin, pending.id);
  });

  // Break caught (§6.8: "at most one ACTIVE factor per identity"): two proven factors for one identity, which would make "the factor"
  // ambiguous at sign-in.
  it('is the only ACTIVE factor of its identity', async () => {
    const owner = await identity();
    const first = await factorOf(owner.id);
    const second = await factorOf(owner.id);
    await activateFactor(admin, first.id);

    const refusal = await refusalOf(
      `update mfa_factor set status = 'ACTIVE', enrolled_at = clock_timestamp(), last_verified_counter = '1' where id = $1`,
      [second.id],
    );

    expect(refusal?.code).toBe('23505');
    expect(refusal?.constraint).toBe('mfa_factor_one_active_key');
    // Enrolling a replacement revokes the previous one, in the same transaction, and the other identity is no part of the rule.
    await admin.query('begin');
    try {
      await admin.query(
        `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
        [first.id],
      );
      await activateFactor(admin, second.id);
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }
    const other = await identity();
    await activateFactor(admin, (await factorOf(other.id)).id);
  });

  // Break caught: a factor with no identity, or an identity removed from under its factor.
  it('belongs to a staff identity that exists, which cannot be removed under it', async () => {
    expect((await refusalOfInsert(factorRow(randomUUID())))?.code).toBe('23503');
    const owner = await identity();
    await factorOf(owner.id);

    // RESTRICT is reported as restrict_violation, not as the foreign key violation of an insert.
    expect((await refusalOf(`delete from staff_identity where id = $1`, [owner.id]))?.code).toBe(
      '23001',
    );
  });
});

describe('a factor moves along the state machine of state-machines.md §18, whoever updates it', () => {
  // Break caught: a proven factor sent back to PENDING, or a revoked one brought back, which would resurrect an authenticator that was
  // taken away.
  it('goes from PENDING to ACTIVE or REVOKED and from ACTIVE to REVOKED, and never back', async () => {
    const { factor } = await withActiveFactor();

    const back = await refusalOf(
      `update mfa_factor set status = 'PENDING', enrolled_at = null where id = $1`,
      [factor.id],
    );
    expect(back?.code).toBe('23514');
    expect(back?.message).toMatch(/proven once/);

    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [factor.id],
    );
    for (const assignment of [
      `status = 'ACTIVE'`,
      `status = 'PENDING', enrolled_at = null, revoked_at = null`,
      `revoked_at = revoked_at + interval '1 second'`,
      `last_verified_counter = '99999'`,
      `revoked_by = gen_random_uuid()`,
    ]) {
      const refusal = await refusalOf(`update mfa_factor set ${assignment} where id = $1`, [
        factor.id,
      ]);
      expect(refusal?.code, assignment).toBe('23514');
      expect(refusal?.message, assignment).toMatch(/REVOKED factor stays as it ended/);
    }
  });

  it('is revoked from PENDING when an enrolment is abandoned, with no administrator', async () => {
    const owner = await identity();
    const pending = await factorOf(owner.id);

    expect(
      await refusalOf(
        `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
        [pending.id],
      ),
    ).toBeUndefined();
    expect((await stateOf(pending.id))?.revoked_by).toBeNull();
  });

  // Break caught (§6.8: "enrolled_at ... non-null from ACTIVE"): the enrolment moment rewritten later.
  it('keeps the moment it was enrolled, once set', async () => {
    const { factor } = await withActiveFactor();

    for (const assignment of [
      `enrolled_at = enrolled_at + interval '1 minute'`,
      `enrolled_at = null`,
    ]) {
      expect(
        (await refusalOf(`update mfa_factor set ${assignment} where id = $1`, [factor.id]))?.code,
      ).toBe('23514');
    }
  });

  // Break caught: a column that makes a factor what it is rewritten after the fact. The guard holds the administrator too ("a trigger
  // refuses a change by any login").
  it.each([
    ['id', `id = gen_random_uuid()`],
    ['staff_identity_id', `staff_identity_id = $2`],
    ['created_by_purpose', `created_by_purpose = 'BOOTSTRAP_SETUP'`],
    ['created_episode_id', `created_episode_id = gen_random_uuid()`],
  ])('refuses a change of %s', async (column, assignment) => {
    const owner = await identity();
    const other = await identity();
    const row = await factorOf(owner.id);

    const refusal = await refusalOf(
      `update mfa_factor set ${assignment} where id = $1`,
      column === 'staff_identity_id' ? [row.id, other.id] : [row.id],
    );

    expect(refusal?.code).toBe('23514');
    expect(refusal?.message).toMatch(
      /keeps its identity, its type, the purpose that created it and the episode it was created in/,
    );
  });

  // Break caught (§6.8 "replay protection — the time step most recently accepted"): a code accepted twice in its window because the
  // recorded step moved backwards or was not a time step at all.
  it('records the step of the last accepted code, which only moves forward', async () => {
    const { factor } = await withActiveFactor();
    const record = (value: string | null): Promise<Refusal | undefined> =>
      refusalOf(`update mfa_factor set last_verified_counter = $2 where id = $1`, [
        factor.id,
        value,
      ]);

    expect(await record('1001')).toBeUndefined();
    expect(await record('1001')).toBeUndefined();
    expect(await record('2000000000')).toBeUndefined();
    const backwards = await record('1002');
    expect(backwards?.code).toBe('23514');
    expect(backwards?.message).toMatch(/only moves forward/);
    expect((await record(null))?.message).toMatch(/only moves forward/);
    for (const text of ['', '-1', '1.5', 'abc', '01', ' 7']) {
      expect((await record(text))?.constraint, text).toBe('mfa_factor_counter_shape');
    }
  });
});

describe('a revocation by an administrator is one write with its three facts (domain-model.md §6.8)', () => {
  // Break caught: a half revocation, which `resetStaffMfa` reads: an administrator with no reason, a reason with no administrator, an
  // episode with neither, or an administrator revoking their own factor (the actor is not the target).
  it('names the administrator, the reason and the episode together, or none of them, and not the identity itself', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const actor = await identity();
    const episode = randomUUID();
    await grant({ principalId: owner.id, purpose: 'MFA_REENROLMENT', episodeId: episode });
    const half = (assignment: string): Promise<Refusal | undefined> =>
      refusalOf(
        `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp(), ${assignment} where id = $1`,
        [factor.id],
      );

    expect((await half(`revoked_by = '${actor.id}'`))?.constraint).toBe(
      'mfa_factor_administrative_revocation_whole',
    );
    expect((await half(`revocation_reason_code = 'MFA_AUTHENTICATOR_UNAVAILABLE'`))?.code).toBe(
      '23514',
    );
    expect(
      (
        await half(
          `revocation_reason_code = 'MFA_AUTHENTICATOR_UNAVAILABLE', revoked_by = '${actor.id}'`,
        )
      )?.constraint,
    ).toBe('mfa_factor_administrative_revocation_whole');
    expect(
      (await revoke(factor.id, owner.id, episode))?.constraint,
      'the actor is the target',
    ).toBe('mfa_factor_actor_is_not_target');
    expect(
      (
        await half(
          `revocation_reason_code = '   ', revoked_by = '${actor.id}', revocation_episode_id = '${episode}'`,
        )
      )?.constraint,
    ).toBe('mfa_factor_administrative_revocation_whole');
    expect(await revoke(factor.id, actor.id, episode)).toBeUndefined();
  });

  // Break caught: the administrative fields on a factor that is not revoked.
  it('is recorded on a REVOKED factor only', async () => {
    const { factor } = await withActiveFactor();
    const actor = await identity();

    const refusal = await refusalOf(
      `update mfa_factor set revoked_by = $2, revocation_reason_code = 'MFA_AUTHENTICATOR_UNAVAILABLE', revocation_episode_id = gen_random_uuid()
        where id = $1`,
      [factor.id, actor.id],
    );

    expect(refusal?.code).toBe('23514');
  });

  // Break caught (§6.8: "exactly one legal write: from null to a reset episode of the same identity, in the same statement that sets
  // status to REVOKED and revoked_by"): the valid write refused.
  it('accepts the one legal write of the revocation episode: null to an episode of the same identity, with the revocation', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const actor = await identity();
    const episode = randomUUID();
    await grant({
      principalId: owner.id,
      purpose: 'MFA_REENROLMENT',
      episodeId: episode,
      issuedBy: actor.id,
    });

    expect(await revoke(factor.id, actor.id, episode)).toBeUndefined();

    expect(await stateOf(factor.id)).toMatchObject({
      status: 'REVOKED',
      revoked_by: actor.id,
      revocation_reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE',
      revocation_episode_id: episode,
    });
  });

  // Break caught: an episode written to a factor with no revocation behind it, or by the system, which would pass an unfinished
  // reset off as a finished one (the reader of `resetStaffMfa` takes `revoked_by` and the episode as the record of an administrator's act).
  it('refuses an episode with no administrative revocation: on a live factor, or on a revocation by the system', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const episode = randomUUID();
    await grant({ principalId: owner.id, purpose: 'MFA_REENROLMENT', episodeId: episode });

    const live = await refusalOf(`update mfa_factor set revocation_episode_id = $2 where id = $1`, [
      factor.id,
      episode,
    ]);
    expect(live?.code).toBe('23514');
    expect(live?.message).toMatch(
      /revocation episode is written once, with an administrative revocation/,
    );

    const bySystem = await refusalOf(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp(), revocation_episode_id = $2 where id = $1`,
      [factor.id, episode],
    );
    expect(bySystem?.code).toBe('23514');
  });

  // Break caught: the episode of a revoked factor overwritten or cleared later, which would hide which reset the factor belongs to.
  it('refuses to overwrite or clear the episode once written', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const actor = await identity();
    const first = randomUUID();
    const second = randomUUID();
    await grant({ principalId: owner.id, purpose: 'MFA_REENROLMENT', episodeId: first });
    await grant({ principalId: owner.id, purpose: 'MFA_ENROLMENT', episodeId: second });
    expect(await revoke(factor.id, actor.id, first)).toBeUndefined();

    for (const assignment of [
      `revocation_episode_id = '${second}'`,
      `revocation_episode_id = null`,
      `revocation_episode_id = null, revoked_by = null, revocation_reason_code = null`,
    ]) {
      const refusal = await refusalOf(`update mfa_factor set ${assignment} where id = $1`, [
        factor.id,
      ]);
      expect(refusal?.code, assignment).toBe('23514');
    }
  });

  // Break caught (§6.8: "a constraint trigger deferred to commit requires a SetupGrant of the same principal and episode to exist"):
  // an episode of another identity's reset, or an episode that no grant carries.
  it('refuses, at commit, an episode that no grant of the same identity carries', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const other = await identity();
    const actor = await identity();
    const foreign = randomUUID();
    await grant({ principalId: other.id, purpose: 'MFA_REENROLMENT', episodeId: foreign });

    const ofAnother = await revoke(factor.id, actor.id, foreign);
    expect(ofAnother?.code).toBe('23503');
    expect(ofAnother?.message).toMatch(/names a setup grant of the same identity/);
    const ofNone = await revoke(factor.id, actor.id, randomUUID());
    expect(ofNone?.code).toBe('23503');
    expect(owner.id).not.toBe(other.id);
    expect((await stateOf(factor.id))?.status).toBe('ACTIVE');
  });

  // Break caught: a deferred check that fires at the statement, so that a reset could not write the revocation before the grant of its
  // own episode, which `resetStaffMfa` does in one transaction in whatever order its steps run.
  it('judges the episode at commit, so that the grant of the episode may come after the revocation in the same transaction', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const actor = await identity();
    const episode = randomUUID();

    await admin.query('begin');
    try {
      expect(await revoke(factor.id, actor.id, episode)).toBeUndefined();
      await grant({ principalId: owner.id, purpose: 'MFA_REENROLMENT', episodeId: episode });
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }

    expect((await stateOf(factor.id))?.revocation_episode_id).toBe(episode);
  });

  it('rolls the whole transaction back when the episode is still missing at commit', async () => {
    const { factor } = await withActiveFactor();
    const actor = await identity();

    await admin.query('begin');
    let failure: Refusal | undefined;
    try {
      await revoke(factor.id, actor.id, randomUUID());
      await admin.query('commit');
    } catch (error) {
      failure = refusalFrom(error);
      await admin.query('rollback');
    }

    expect(failure?.code).toBe('23503');
    expect((await stateOf(factor.id))?.status).toBe('ACTIVE');
  });
});

describe('the episode a factor was created in (domain-model.md §6.8)', () => {
  // Break caught: an episode on a factor an onboarding or the bootstrap created ("null for onboarding and bootstrap"), or a re-enrolment
  // factor that names an episode of another identity.
  it('is carried by a factor that a re-enrolment created, and by no other', async () => {
    const owner = await identity();
    const episode = randomUUID();
    await grant({ principalId: owner.id, purpose: 'MFA_REENROLMENT', episodeId: episode });

    expect(
      (await refusalOfInsert(factorRow(owner.id, { createdEpisodeId: episode })))?.constraint,
    ).toBe('mfa_factor_episode_by_purpose');
    await factorOf(owner.id, { createdByPurpose: 'MFA_REENROLMENT', createdEpisodeId: episode });
  });

  it('names an episode that a grant of the same identity carries', async () => {
    const owner = await identity();
    const other = await identity();
    const episode = randomUUID();
    await grant({ principalId: other.id, purpose: 'MFA_REENROLMENT', episodeId: episode });

    const refusal = await refusalOfInsert(
      factorRow(owner.id, { createdByPurpose: 'MFA_REENROLMENT', createdEpisodeId: episode }),
    );

    expect(refusal?.code).toBe('23503');
    expect(refusal?.message).toMatch(/names a setup grant of the same identity/);
    expect(
      (
        await refusalOfInsert(
          factorRow(owner.id, {
            createdByPurpose: 'MFA_REENROLMENT',
            createdEpisodeId: randomUUID(),
          }),
        )
      )?.code,
    ).toBe('23503');
  });

  // Break caught (§18: "a factor created in episode A that is later reset into episode B keeps A and gains B").
  it('keeps the episode it was created in when it is later reset into another', async () => {
    const owner = await identity();
    const actor = await identity();
    const created = randomUUID();
    const reset = randomUUID();
    // The re-enrolment grant of the first episode was consumed to create the factor; the reset then issues another, of a new episode.
    const reenrolment = await grant({
      principalId: owner.id,
      purpose: 'MFA_REENROLMENT',
      episodeId: created,
    });
    await setGrantState(admin, reenrolment.id, 'CONSUMED');
    const factor = await factorOf(owner.id, {
      createdByPurpose: 'MFA_REENROLMENT',
      createdEpisodeId: created,
    });
    await activateFactor(admin, factor.id);
    await grant({ principalId: owner.id, purpose: 'MFA_REENROLMENT', episodeId: reset });

    expect(await revoke(factor.id, actor.id, reset)).toBeUndefined();

    expect(await stateOf(factor.id)).toMatchObject({
      created_episode_id: created,
      revocation_episode_id: reset,
    });
  });
});

describe('GBT-B14, constraint half, as the API’s login under the authentication capability', () => {
  const authentication = systemContext('authentication');
  const asApi = <T>(
    work: (tx: Parameters<Parameters<typeof withHandle>[2]>[1]) => Promise<T>,
    ctx: SecurityContext = authentication,
  ): Promise<T> => withHandle(api.service, ctx, (_handle, tx) => work(tx));
  const failure = async (action: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await action();
      return undefined;
    } catch (error) {
      return serverErrorIn(error)?.code;
    }
  };

  const updatable = async (table: string): Promise<string[]> => {
    const result = await admin.query<{ column: string }>(
      `select a.attname as column
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relname = $1 and c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('melarc_api_runtime', c.oid, a.attnum, 'UPDATE')
        order by a.attname`,
      [table],
    );
    return result.rows.map((row) => row.column);
  };

  // Break caught (S0.29 evidence): "no UPDATE privilege exists on grant lineage, created_episode_id, created_by_purpose,
  // staff_identity_id or origin". The privilege error is the first line of defence and the trigger the second.
  it('holds no UPDATE privilege on a grant’s lineage, a factor’s creation facts, its identity, or a staff identity’s origin', async () => {
    const grantColumns = await updatable('setup_grant');
    const factorColumns = await updatable('mfa_factor');
    const staffColumns = await updatable('staff_identity');

    for (const column of ['episode_id', 'supersedes_grant_id', 'continued_from_grant_id']) {
      expect(grantColumns).not.toContain(column);
    }
    for (const column of ['created_episode_id', 'created_by_purpose', 'staff_identity_id']) {
      expect(factorColumns).not.toContain(column);
    }
    expect(staffColumns).not.toContain('origin');
    expect(factorColumns).toEqual(
      [
        'status',
        'enrolled_at',
        'revoked_at',
        'last_verified_counter',
        'revoked_by',
        'revocation_reason_code',
        'revocation_episode_id',
      ].toSorted(),
    );
  });

  // Break caught (§6.8: "never table-wide"): a table-level UPDATE, which would also reach the columns above and every column a later
  // migration adds.
  it('holds no table-wide UPDATE and no DELETE or TRUNCATE on either table', async () => {
    for (const table of ['mfa_factor', 'setup_grant']) {
      const privileges = await admin.query(
        `select has_table_privilege('melarc_api_runtime', $1, 'UPDATE') as "update",
                has_table_privilege('melarc_api_runtime', $1, 'DELETE') as "delete",
                has_table_privilege('melarc_api_runtime', $1, 'TRUNCATE') as "truncate"`,
        [table],
      );
      expect(privileges.rows[0], table).toEqual({ update: false, delete: false, truncate: false });
    }
    const owner = await identity();
    const row = await factorOf(owner.id);
    const other = await identity();

    expect(
      await failure(() =>
        asApi((tx) =>
          tx.execute(
            sql`update mfa_factor set staff_identity_id = ${other.id} where id = ${row.id}`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await failure(() =>
        asApi((tx) => tx.execute(sql`delete from mfa_factor where id = ${row.id}`)),
      ),
    ).toBe('42501');
  });

  // Break caught: the immutable columns writable through some route the privileges leave, or a trigger that stops at the API.
  it('is refused a change of any creation fact with the privilege error, and by the trigger for any other login', async () => {
    const owner = await identity();
    const row = await factorOf(owner.id);

    for (const assignment of [
      sql`created_by_purpose = 'BOOTSTRAP_SETUP'`,
      sql`created_episode_id = gen_random_uuid()`,
      sql`factor_type = 'TOTP'`,
    ]) {
      expect(
        await failure(() =>
          asApi((tx) => tx.execute(sql`update mfa_factor set ${assignment} where id = ${row.id}`)),
        ),
      ).toBe('42501');
    }
    expect(
      (
        await refusalOf(
          `update mfa_factor set created_by_purpose = 'BOOTSTRAP_SETUP' where id = $1`,
          [row.id],
        )
      )?.code,
    ).toBe('23514');
    expect(
      await failure(() =>
        asApi((tx) =>
          tx.execute(sql`update staff_identity set origin = 'BOOTSTRAP' where id = ${owner.id}`),
        ),
      ),
    ).toBe('42501');
  });

  const revokeAs = (
    factorId: string,
    actor: string,
    episode: string | null,
    reason: string | null = 'MFA_AUTHENTICATOR_UNAVAILABLE',
  ): ReturnType<typeof sql> =>
    sql`update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp(), revoked_by = ${actor},
                              revocation_reason_code = ${reason}, revocation_episode_id = ${episode}
         where id = ${factorId}`;

  const grantFor = (principalId: string, episode: string): ReturnType<typeof sql> =>
    sql`insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, episode_id)
        values (${randomUUID()}, 'STAFF', ${principalId}, 'MFA_REENROLMENT', ${Buffer.from(randomUUID().replaceAll('-', '').repeat(2), 'hex')},
                clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING', ${episode})`;

  // Break caught (the valid write): `resetStaffMfa`'s one statement refused to the runtime login, or accepted only with a table-wide
  // grant. The grant of the new episode is written in the same transaction, which is how the reset issues its re-enrolment grant.
  it('succeeds in the valid reset write: the revocation and its episode in one statement, in the reset’s own transaction', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const actor = await identity();
    const episode = randomUUID();

    await asApi(async (tx) => {
      await tx.execute(revokeAs(factor.id, actor.id, episode));
      await tx.execute(grantFor(owner.id, episode));
    });

    expect(await stateOf(factor.id)).toMatchObject({
      status: 'REVOKED',
      revoked_by: actor.id,
      revocation_episode_id: episode,
    });
  });

  // Break caught: each illegal write of `revocation_episode_id`, as the runtime login, which holds UPDATE on the column.
  it.each([
    ['an overwrite', 'overwrite'],
    ['a clearing', 'clear'],
    ['a value on a live factor, with no administrative revocation', 'live'],
    ['a revocation by the system carrying an episode', 'system'],
  ])('refuses %s', async (_label, kind) => {
    const { identity: owner, factor } = await withActiveFactor();
    const actor = await identity();
    const first = randomUUID();
    const second = randomUUID();
    await grant({ principalId: owner.id, purpose: 'MFA_REENROLMENT', episodeId: first });
    await grant({ principalId: owner.id, purpose: 'MFA_ENROLMENT', episodeId: second });
    if (kind === 'overwrite' || kind === 'clear') await revoke(factor.id, actor.id, first);

    const attempt = {
      overwrite: sql`update mfa_factor set revocation_episode_id = ${second} where id = ${factor.id}`,
      clear: sql`update mfa_factor set revocation_episode_id = null where id = ${factor.id}`,
      live: sql`update mfa_factor set revocation_episode_id = ${first} where id = ${factor.id}`,
      system: sql`update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp(), revocation_episode_id = ${first} where id = ${factor.id}`,
    }[kind as 'overwrite' | 'clear' | 'live' | 'system'];

    expect(await failure(() => asApi((tx) => tx.execute(attempt)))).toBe('23514');
  });

  // Break caught (the evidence): another principal's episode, which the deferred constraint trigger alone can refuse, at commit, as the
  // runtime login.
  it('refuses another principal’s episode, at commit', async () => {
    const { factor } = await withActiveFactor();
    const other = await identity();
    const actor = await identity();
    const foreign = randomUUID();

    const code = await failure(() =>
      asApi(async (tx) => {
        await tx.execute(grantFor(other.id, foreign));
        await tx.execute(revokeAs(factor.id, actor.id, foreign));
      }),
    );

    expect(code).toBe('23503');
    expect((await stateOf(factor.id))?.status).toBe('ACTIVE');
  });

  // Break caught: a half revocation (no reason) as the runtime login, which would record an administrator's act with no reason.
  it('refuses a revocation that names the administrator and no reason', async () => {
    const { identity: owner, factor } = await withActiveFactor();
    const actor = await identity();
    const episode = randomUUID();

    const code = await failure(() =>
      asApi(async (tx) => {
        await tx.execute(grantFor(owner.id, episode));
        await tx.execute(revokeAs(factor.id, actor.id, episode, null));
      }),
    );

    expect(code).toBe('23514');
  });

  // Break caught (the evidence): a lineage reference to another principal's grant, as the runtime login; and a lineage written after
  // the insert.
  it('refuses a lineage reference to another principal’s grant, and a later write of any lineage column', async () => {
    const principalId = randomUUID();
    const other = await grant({ principalId: randomUUID() });
    await setGrantState(admin, other.id, 'SUPERSEDED');
    // `mine` is of another purpose, so that the unique index of live grants is not what refuses the insert below.
    const mine = await grant({ principalId, purpose: 'MFA_ENROLMENT' });
    const row = grantRow({ principalId, supersedesGrantId: other.id });

    const insert = await failure(() =>
      asApi((tx) =>
        tx.execute(sql`
          insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, supersedes_grant_id)
          values (${row.id}, 'STAFF', ${principalId}, 'STAFF_CREDENTIAL_SETUP', ${row.tokenHash}, now(), now() + interval '30 minutes', 'PENDING', ${other.id})`),
      ),
    );
    const rewrite = await failure(() =>
      asApi((tx) =>
        tx.execute(
          sql`update setup_grant set supersedes_grant_id = ${other.id} where id = ${mine.id}`,
        ),
      ),
    );

    expect(insert).toBe('23503');
    expect(rewrite).toBe('42501');
  });
});
