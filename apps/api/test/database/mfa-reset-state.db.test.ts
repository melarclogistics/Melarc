import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadResetFacts,
  mfaPostureOf,
  type MfaPosture,
} from '../../src/platform/auth/mfa/mfa-reset-state.js';
import { randomUUIDv7 } from '../../src/platform/auth/crypto/uuid-v7.js';
import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
  setGrantState,
} from './support/credentials.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.35, the facts and the posture of a staff identity's second factor against a real PostgreSQL: what `mfa_enrolled` and
 * `mfa_reset_state` of `StaffIdentity` say for each recorded history. The rule that decides is
 * `mfa-reset-state.test.ts`; here are the rows it is made from and the read that gathers them through `melarc.staff_reset_facts`, here
 * under the `authentication` capability (the staff context's access is `staff-reset-facts.db.test.ts`). Every history is arranged as the administrator
 * and reaches its state by the transitions the tables allow.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let unitOfWork: PostgresUnitOfWork;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
  unitOfWork = new PostgresUnitOfWork(built.service);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const privileged = (overrides: Partial<StaffRow> = {}) =>
  insertStaff(admin, staffRow({ roleBundleId: BUNDLE_IDS.seniorOps, ...overrides }));

const postureOf = async (...rows: readonly StaffRow[]): Promise<ReadonlyMap<string, MfaPosture>> =>
  unitOfWork.run(systemContext('authentication'), (handle) =>
    mfaPostureOf(
      handle,
      rows.map((row) => row.id),
    ),
  );
const stateOf = async (row: StaffRow): Promise<string | undefined> =>
  (await postureOf(row)).get(row.id)?.resetState;

/** A factor's id is a UUIDv7 and **not an order**: the rule reads the latest factor by the ordinal the database allocated. */
const factorId = (): string => randomUUIDv7({ now: () => new Date() });

/** Two ids that sort against the order of creation: the factor made first has the greater one (a clock that stepped back, or one millisecond). */
const backwards = (): [string, string] => {
  const tail = randomUUID().slice(24);
  return [`ffffffff-ffff-7fff-bfff-${tail}`, `00000000-0000-7000-8000-${tail}`];
};

/** A factor made `ACTIVE` through the machine. */
async function enrolled(row: StaffRow, overrides = {}): Promise<string> {
  const factor = await insertFactor(admin, factorRow(row.id, { id: factorId(), ...overrides }));
  await activateFactor(admin, factor.id);
  return factor.id;
}

/** A factor an administrator revoked in a reset episode, with the re-enrolment grant the episode needs (the table requires the pair). */
async function resetByAnAdministrator(
  row: StaffRow,
  by: StaffRow,
  grantState?: 'EXPIRED' | 'SUPERSEDED',
  id?: string,
): Promise<{ readonly factorId: string; readonly grantId: string }> {
  const factorId = await enrolled(row, id === undefined ? {} : { id });
  const episode = randomUUID();
  // A grant that is to end as EXPIRED was issued long ago: the machine ends it only once its time has passed.
  const issuedAt = new Date(Date.now() - (grantState === 'EXPIRED' ? 120 : 1) * 60_000);
  const grant = grantRow({
    principalId: row.id,
    purpose: 'MFA_REENROLMENT',
    issuedBy: by.id,
    episodeId: episode,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 30 * 60_000),
  });
  await admin.query('begin');
  try {
    await insertGrant(admin, grant);
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp(), revoked_by = $2,
                             revocation_reason_code = 'MFA_AUTHENTICATOR_UNAVAILABLE', revocation_episode_id = $3 where id = $1`,
      [factorId, by.id, episode],
    );
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
  if (grantState !== undefined) await setGrantState(admin, grant.id, grantState);
  return { factorId, grantId: grant.id };
}

describe('state 1: an ACTIVE factor', () => {
  // Break caught: the proven factor not read as one, or `mfa_enrolled` standing in for the reset state.
  it.each(['ACTIVE', 'SUSPENDED'])(
    'is FACTOR_ACTIVE and enrolled for a privileged %s identity with a proven factor',
    async (status) => {
      const row = await privileged({ status });
      await enrolled(row);

      expect((await postureOf(row)).get(row.id)).toMatchObject({
        mfaEnrolled: true,
        resetState: 'FACTOR_ACTIVE',
      });
    },
  );

  // Break caught: the bootstrap administrator not reached in state 1, which is the one state it is reached in.
  it('is FACTOR_ACTIVE for a bootstrap administrator', async () => {
    const row = await insertStaff(
      admin,
      staffRow({
        roleBundleId: BUNDLE_IDS.platformAdmin,
        origin: 'BOOTSTRAP',
        createdBy: '4d414b45-0000-4000-8000-000000000001',
        approvedBy: '4d414b45-0000-4000-8000-000000000002',
      }),
    );
    await enrolled(row);

    expect(await stateOf(row)).toBe('FACTOR_ACTIVE');
  });
});

describe('state 2: a stranded enrolment', () => {
  /** A privileged identity with a `PENDING` factor and the continuation grant that its credential setup issued. */
  async function enrolling(grantState?: 'EXPIRED' | 'CONSUMED') {
    const row = await privileged();
    await insertFactor(admin, factorRow(row.id));
    const grant = await insertGrant(
      admin,
      grantRow({ principalId: row.id, purpose: 'MFA_ENROLMENT' }),
    );
    if (grantState === 'EXPIRED') {
      // The grant lapsed unused: the state machine ends it as EXPIRED, and the time is the database's.
      await admin.query('alter table setup_grant disable trigger all');
      await admin.query(
        `update setup_grant set expires_at = clock_timestamp() - interval '1 minute', issued_at = issued_at - interval '1 hour' where id = $1`,
        [grant.id],
      );
      await admin.query('alter table setup_grant enable trigger all');
    }
    return { row, grant };
  }

  // Break caught: a live enrolment, with a grant a person can still redeem, offered a reset.
  it('is NOT_ELIGIBLE while a usable MFA_ENROLMENT grant exists', async () => {
    const { row } = await enrolling();

    expect((await postureOf(row)).get(row.id)).toMatchObject({
      mfaEnrolled: false,
      resetState: 'NOT_ELIGIBLE',
    });
  });

  // Break caught: a grant past its time still counted as usable, which strands the identity for good (the clock is the database's).
  it('is ENROLMENT_UNFINISHED when the grant lapsed and nothing is being delivered', async () => {
    const { row } = await enrolling('EXPIRED');

    expect(await stateOf(row)).toBe('ENROLMENT_UNFINISHED');
  });

  // Break caught: a stranded enrolment whose message is still queued offered a reset, which would supersede the grant a person is
  // about to receive.
  it('is NOT_ELIGIBLE while a delivery attempt of the grant is pending, whatever the grant says', async () => {
    const { row, grant } = await enrolling('EXPIRED');
    await admin.query(
      `insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id,
                                            channel, state, next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext,
                                            payload_nonce, payload_key_version, payload_envelope_version)
       values ($1, 'MFA_REENROLMENT', 'SETUP_GRANT', $2, 'STAFF', $3, 'EMAIL', 'QUEUED', now(),
               now() + interval '1 hour', $4, decode(repeat('ab', 40), 'hex'), decode(repeat('cd', 12), 'hex'), 1, 1)`,
      [randomUUID(), grant.id, row.id, randomUUID()],
    );

    expect(await stateOf(row)).toBe('NOT_ELIGIBLE');
  });

  // Break caught: a bootstrap administrator's stranded enrolment reached through the reset instead of the provisioning channel.
  it('is NOT_ELIGIBLE for a bootstrap administrator', async () => {
    const row = await insertStaff(
      admin,
      staffRow({
        roleBundleId: BUNDLE_IDS.platformAdmin,
        origin: 'BOOTSTRAP',
        createdBy: '4d414b45-0000-4000-8000-000000000001',
        approvedBy: '4d414b45-0000-4000-8000-000000000002',
      }),
    );
    await insertFactor(admin, factorRow(row.id));
    const grant = await insertGrant(
      admin,
      grantRow({ principalId: row.id, purpose: 'MFA_ENROLMENT' }),
    );
    await admin.query('alter table setup_grant disable trigger all');
    await admin.query(
      `update setup_grant set expires_at = clock_timestamp() - interval '1 minute', issued_at = issued_at - interval '1 hour' where id = $1`,
      [grant.id],
    );
    await admin.query('alter table setup_grant enable trigger all');

    expect(await stateOf(row)).toBe('NOT_ELIGIBLE');
  });
});

describe('state 3: an unfinished reset', () => {
  // Break caught: an administrator's revocation with no replacement factor not offered the reset again, in either way the grant ends.
  it.each(['EXPIRED', 'SUPERSEDED'] as const)(
    'is ENROLMENT_UNFINISHED when an administrator revoked the factor and the re-enrolment grant ended %s',
    async (ended) => {
      const row = await privileged();
      const by = await privileged();
      await resetByAnAdministrator(row, by, ended);

      expect((await postureOf(row)).get(row.id)).toMatchObject({
        mfaEnrolled: false,
        resetState: 'ENROLMENT_UNFINISHED',
      });
    },
  );

  // Break caught: the system's ending of a factor (a replacement, an abandoned enrolment) read as a reset that was started.
  it('is NOT_ELIGIBLE for a factor the system revoked, and for an identity with no factor at all', async () => {
    const replaced = await privileged();
    const factorId = await enrolled(replaced);
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [factorId],
    );
    const none = await privileged();

    expect(await stateOf(replaced)).toBe('NOT_ELIGIBLE');
    expect(await stateOf(none)).toBe('NOT_ELIGIBLE');
  });

  // Break caught (F01 of the audit of 22 October 2026): the latest factor read as the one with the greatest identifier. The factor an
  // administrator revoked was made first and has the greater id; the factor made after it, and ended by the system, has the smaller.
  // The most recent is the second, whatever the identifiers say: NOT_ELIGIBLE.
  it('judges by the order of creation when the identifiers say the opposite: an administrator’s revocation followed by a system one is NOT_ELIGIBLE', async () => {
    const row = await privileged();
    const by = await privileged();
    const [first, second] = backwards();
    await resetByAnAdministrator(row, by, 'EXPIRED', first);
    const abandoned = await insertFactor(admin, factorRow(row.id, { id: second }));
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [abandoned.id],
    );

    expect(await stateOf(row)).toBe('NOT_ELIGIBLE');
  });

  // Break caught: the reverse: the system ended the first factor (the greater id), an administrator revoked the second (the smaller)
  // and no replacement came: the unfinished reset of state 3, which the greatest identifier would have hidden.
  it('judges by the order of creation when the identifiers say the opposite: a system revocation followed by an administrator’s is ENROLMENT_UNFINISHED', async () => {
    const row = await privileged();
    const by = await privileged();
    const [first, second] = backwards();
    const replaced = await insertFactor(admin, factorRow(row.id, { id: first }));
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [replaced.id],
    );
    await resetByAnAdministrator(row, by, 'EXPIRED', second);

    expect(await stateOf(row)).toBe('ENROLMENT_UNFINISHED');
  });

  // Break caught: the oldest factor read as the latest (the greatest id is the most recent): an administrator's revocation long ago
  // outweighing the factor the system ended since.
  it('judges the latest factor and not an earlier one: a reset followed by an enrolment the system abandoned is NOT_ELIGIBLE', async () => {
    const row = await privileged();
    const by = await privileged();
    await resetByAnAdministrator(row, by, 'EXPIRED');
    const abandoned = await insertFactor(
      admin,
      factorRow(row.id, { id: factorId(), createdByPurpose: 'STAFF_CREDENTIAL_SETUP' }),
    );
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [abandoned.id],
    );

    expect(await stateOf(row)).toBe('NOT_ELIGIBLE');
  });

  // Break caught: an earlier revocation by an administrator read as the state of an identity that has since been re-enrolled.
  it('is NOT_ELIGIBLE and FACTOR_ACTIVE once a later factor is proven, whatever the history', async () => {
    const row = await privileged();
    const by = await privileged();
    await resetByAnAdministrator(row, by, 'EXPIRED');
    await enrolled(row, { createdByPurpose: 'MFA_REENROLMENT' });

    expect(await stateOf(row)).toBe('FACTOR_ACTIVE');
  });
});

describe('what no history makes eligible', () => {
  // Break caught: a non-privileged identity, an identity with no established password, or one in another status offered a reset.
  it('is NOT_ELIGIBLE for a non-privileged identity, one with no password and a PENDING_APPROVAL or OFFBOARDED one', async () => {
    const ordinary = await insertStaff(admin, staffRow({ roleBundleId: BUNDLE_IDS.opsStaff }));
    await enrolled(ordinary);
    const noPassword = await insertStaff(
      admin,
      staffRow({
        roleBundleId: BUNDLE_IDS.seniorOps,
        credentialHash: null,
        credentialEstablishedAt: null,
      }),
    );
    const pending = await insertStaff(
      admin,
      staffRow({
        roleBundleId: BUNDLE_IDS.seniorOps,
        status: 'PENDING_APPROVAL',
        approvedBy: null,
      }),
    );
    const offboarded = await privileged();
    await enrolled(offboarded);
    await admin.query(`update staff_identity set status = 'OFFBOARDED' where id = $1`, [
      offboarded.id,
    ]);

    const posture = await postureOf(ordinary, noPassword, pending, offboarded);

    for (const row of [ordinary, noPassword, pending, offboarded]) {
      expect(posture.get(row.id)?.resetState).toBe('NOT_ELIGIBLE');
    }
  });
});

describe('the read', () => {
  // Break caught: an identity that is not there answered as one that is not eligible: the posture holds the identities it was given
  // that exist, and no other.
  it('answers for the identities that exist and for no other', async () => {
    const row = await privileged();

    const posture = await unitOfWork.run(systemContext('authentication'), (handle) =>
      mfaPostureOf(handle, [row.id, randomUUID()]),
    );

    expect([...posture.keys()]).toEqual([row.id]);
  });

  // Break caught: a read of nothing costing a statement, or an empty list reaching SQL as an unusable array.
  it('reads nothing for no identity', async () => {
    const posture = await unitOfWork.run(systemContext('authentication'), (handle) =>
      mfaPostureOf(handle, []),
    );

    expect(posture.size).toBe(0);
  });

  // Break caught: the facts of an identity not being the ones the decision reads: the same read decides `resetStaffMfa` (S0.37).
  it('gathers the facts the rule is made from', async () => {
    const row = await privileged();
    await enrolled(row);

    const facts = await unitOfWork.run(systemContext('authentication'), (handle) =>
      loadResetFacts(handle, [row.id]),
    );

    expect(facts.get(row.id)).toMatchObject({
      status: 'ACTIVE',
      origin: 'MAKER_CHECKER',
      privileged: true,
      hasCredential: true,
      hasActiveFactor: true,
      hasPendingFactor: false,
      latestFactor: { status: 'ACTIVE' },
    });
  });
});
