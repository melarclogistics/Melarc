import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { Sha256TokenService } from '../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import type { PrincipalRef } from '../../src/platform/auth/ports/identity-directory.port.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import {
  SetupGrantContextError,
  SetupGrantExpiredError,
  SetupGrantRequestError,
} from '../../src/platform/auth/setup-grants/setup-grant-errors.js';
import {
  SetupGrantStore,
  type IssueGrantRequest,
} from '../../src/platform/auth/setup-grants/setup-grant-store.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { SettingsReader } from '../../src/platform/settings/settings-reader.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { delayConsumption, refuseConsumption } from './support/guard-race.js';
import { hashOf } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.29, the store of setup grants (`platform/auth/setup-grants/`), against a real PostgreSQL as the API's login under the
 * authentication capability. What it does that no table rule can: issue a grant on the database's clock, supersede only a live one,
 * consume once at a fresh database time, and queue or cancel the message that carries a grant in the caller's transaction. No
 * operation calls it yet, and no grant is issued to a person.
 */
const SENTINEL_DESTINATION = 'sentinel.person@example.test';

let database: TestDatabase;
let api: BuiltService;
let admin: Admin;
let observer: Observer;
let store: SetupGrantStore;
const tokens = new Sha256TokenService();

const authentication = systemContext('authentication');
const staff = (): PrincipalRef => ({ type: 'STAFF', id: randomUUID() });

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  api = buildService(database, { poolMax: 6 });
  admin = await openAdmin(database);
  observer = await observe(database);
  const clock = new SystemClock();
  store = new SetupGrantStore({
    tokens,
    queue: new PostgresDeliveryQueue({
      cipher: new AesGcmSecretCipher(localKeys()),
      clock,
    }),
    settings: new SettingsReader(),
    clock,
  });
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await api.close();
  await database.drop();
});

beforeEach(async () => {
  await admin.query(
    'alter table credential_delivery_job disable trigger credential_delivery_job_guard',
  );
  await admin.query('delete from credential_delivery_job');
  await admin.query(
    'alter table credential_delivery_job enable trigger credential_delivery_job_guard',
  );
});

const inTransaction = <T>(
  work: (handle: TransactionHandle) => Promise<T>,
  context = authentication,
): Promise<T> => withHandle(api.service, context, (handle) => work(handle));

const issue = (request: IssueGrantRequest) =>
  inTransaction((handle) => store.issue(handle, request));
const consume = (principal: PrincipalRef, purpose: string, token: string) =>
  inTransaction((handle) =>
    store.consume(handle, { principal, purpose: purpose as 'STAFF_CREDENTIAL_SETUP', token }),
  );

const delivery = {
  kind: 'SETUP_GRANT',
  channel: 'EMAIL',
  destination: SENTINEL_DESTINATION,
  link: (token: string) => `https://ops.example.test/setup/credential#token=${token}`,
} as const;

/** Ages a grant by SQL, as the plan's rule says a test ages a row: the expiry is then reached by the data and not by waiting. */
async function age(id: string, minutes: number): Promise<void> {
  await admin.query('alter table setup_grant disable trigger setup_grant_update_guard');
  try {
    await admin.query(
      `update setup_grant set issued_at = issued_at - make_interval(mins => $2),
                              expires_at = expires_at - make_interval(mins => $2) where id = $1`,
      [id, minutes],
    );
  } finally {
    await admin.query('alter table setup_grant enable trigger setup_grant_update_guard');
  }
}

const rowOf = (id: string) =>
  observer.one<{
    state: string;
    purpose: string;
    supersedes_grant_id: string | null;
    continued_from_grant_id: string | null;
    episode_id: string | null;
    issued_by: string | null;
    issued_at: Date;
    expires_at: Date | null;
    consumed_at: Date | null;
    token_hash: Buffer;
  }>(`select * from setup_grant where id = $1`, [id]);
const jobOf = (grantId: string) =>
  observer.one<{ state: string; outcome_class: string | null; expires_at: Date; kind: string }>(
    `select state, outcome_class, expires_at, kind from credential_delivery_job where redemption_record_id = $1`,
    [grantId],
  );

describe('issuing a grant', () => {
  // Break caught: a token stored as shown, a token that is not 32 random bytes, or one that does not look up by its hash.
  it('returns the token once and stores only its SHA-256 hash, PENDING, on the database’s clock', async () => {
    const principal = staff();

    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await rowOf(issued.grant.id);
    expect(row?.state).toBe('PENDING');
    expect(
      row?.token_hash.equals(Buffer.from(tokens.hash(issued.token) ?? new Uint8Array(0))),
    ).toBe(true);
    // The row holds nothing from which the token could be recovered, and the grant it returns holds no hash at all.
    const text = JSON.stringify(
      await observer.rows(`select g::text from setup_grant g where id = $1`, [issued.grant.id]),
    );
    expect(text).not.toContain(issued.token);
    expect(JSON.stringify(issued.grant)).not.toContain('hash');
    expect(issued.grant).toMatchObject({
      principalType: 'STAFF',
      principalId: principal.id,
      purpose: 'STAFF_CREDENTIAL_SETUP',
      state: 'PENDING',
      supersedesGrantId: null,
      continuedFromGrantId: null,
      consumedAt: null,
    });
    const found = await inTransaction((handle) =>
      store.findByTokenHash(handle, tokens.hash(issued.token) ?? new Uint8Array(0)),
    );
    expect(found?.id).toBe(issued.grant.id);
  });

  // Break caught (§6.8: "from recovery_link_ttl_minutes - 30 minutes"; "judged on the database's clock"): an app clock for the issue or a
  // hard-coded lifetime. The expiry is the setting's value after the database's own instant.
  it('expires after the lifetime the setting says, counted from the database’s instant', async () => {
    const issued = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });
    const row = await rowOf(issued.grant.id);

    expect((row?.expires_at?.getTime() ?? 0) - (row?.issued_at.getTime() ?? 0)).toBe(30 * 60_000);
    const databaseNow = await observer.one<{ now: Date }>(`select clock_timestamp() as now`);
    expect(
      Math.abs((databaseNow?.now.getTime() ?? 0) - (row?.issued_at.getTime() ?? 0)),
    ).toBeLessThan(10_000);

    await admin.query(
      `update setting set value = '45'::jsonb where key = 'recovery_link_ttl_minutes'`,
    );
    try {
      const longer = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });
      const longerRow = await rowOf(longer.grant.id);
      expect((longerRow?.expires_at?.getTime() ?? 0) - (longerRow?.issued_at.getTime() ?? 0)).toBe(
        45 * 60_000,
      );
    } finally {
      await admin.query(
        `update setting set value = '30'::jsonb where key = 'recovery_link_ttl_minutes'`,
      );
    }
  });

  // Break caught: a lifetime that is no lifetime, which would issue a grant already dead or one that never ends.
  it.each([
    ['0', /lifetime of a setup grant is a positive whole number/],
    ['-5', /lifetime of a setup grant is a positive whole number/],
    ['"thirty"', /^The setting recovery_link_ttl_minutes/],
    ['1.5', /^The setting recovery_link_ttl_minutes/],
  ])(
    'refuses to issue when the lifetime setting is %s, and writes nothing',
    async (value, refusal) => {
      const principal = staff();
      await admin.query(
        `update setting set value = $1::jsonb where key = 'recovery_link_ttl_minutes'`,
        [value],
      );
      try {
        await expect(issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' })).rejects.toThrow(
          refusal,
        );
      } finally {
        await admin.query(
          `update setting set value = '30'::jsonb where key = 'recovery_link_ttl_minutes'`,
        );
      }
      expect(await observer.count('setup_grant', { principal_id: principal.id })).toBe(0);
    },
  );

  // Break caught (§6.8: "Null only for BOOTSTRAP_SETUP"): the bootstrap secret given a clock, or any other grant none.
  it('gives BOOTSTRAP_SETUP no expiry and reads no lifetime for it', async () => {
    await admin.query(
      `update setting set value = '"unusable"'::jsonb where key = 'recovery_link_ttl_minutes'`,
    );
    try {
      const issued = await issue({ principal: staff(), purpose: 'BOOTSTRAP_SETUP' });

      expect(issued.grant.expiresAt).toBeNull();
      expect((await rowOf(issued.grant.id))?.expires_at).toBeNull();
    } finally {
      await admin.query(
        `update setting set value = '30'::jsonb where key = 'recovery_link_ttl_minutes'`,
      );
    }
  });

  // Break caught (§6.8: "issuing a new grant supersedes any PENDING grant of the same purpose, and only a PENDING one"): two live tokens
  // at once, or a terminal grant rewritten.
  it('supersedes the live grant of the same purpose and names it, and leaves the other purposes and principals alone', async () => {
    const principal = staff();
    const first = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });
    const otherPurpose = await issue({ principal, purpose: 'MFA_ENROLMENT' });
    const otherPrincipal = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });

    const second = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });

    expect(second.supersededGrantId).toBe(first.grant.id);
    expect(second.grant.supersedesGrantId).toBe(first.grant.id);
    expect((await rowOf(first.grant.id))?.state).toBe('SUPERSEDED');
    expect((await rowOf(second.grant.id))?.state).toBe('PENDING');
    expect((await rowOf(otherPurpose.grant.id))?.state).toBe('PENDING');
    expect((await rowOf(otherPrincipal.grant.id))?.state).toBe('PENDING');
    // The earlier token no longer redeems and the later one does.
    expect(await consume(principal, 'STAFF_CREDENTIAL_SETUP', first.token)).toBeNull();
    expect((await consume(principal, 'STAFF_CREDENTIAL_SETUP', second.token))?.id).toBe(
      second.grant.id,
    );
  });

  // Break caught (§6.8: "an expired grant is deliberately never rewritten ... a reissue after the predecessor expired names no
  // predecessor"): an expired grant marked SUPERSEDED and named, which makes the chain say something that did not happen.
  it('marks a grant that has lapsed EXPIRED and names no predecessor', async () => {
    const principal = staff();
    const lapsed = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    await age(lapsed.grant.id, 60);

    const next = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });

    expect(next.supersededGrantId).toBeNull();
    expect(next.expiredGrantIds).toEqual([lapsed.grant.id]);
    expect(next.grant.supersedesGrantId).toBeNull();
    expect((await rowOf(lapsed.grant.id))?.state).toBe('EXPIRED');
  });

  // Break caught: a consumed grant treated as live, or its terminal state rewritten by a later issue.
  it('leaves a consumed grant as it ended and names no predecessor', async () => {
    const principal = staff();
    const first = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    await consume(principal, 'STAFF_CREDENTIAL_SETUP', first.token);

    const next = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });

    expect(next.supersededGrantId).toBeNull();
    expect(next.expiredGrantIds).toEqual([]);
    expect((await rowOf(first.grant.id))?.state).toBe('CONSUMED');
  });

  // Break caught: the lineage of a reset not carried to the row (the episode, the issuing administrator, the continuation source).
  it('writes the episode, the authorising administrator and the continuation source it is given', async () => {
    const principal = staff();
    const episodeId = randomUUID();
    const administrator = randomUUID();
    const reenrolment = await issue({
      principal,
      purpose: 'MFA_REENROLMENT',
      episodeId,
      issuedBy: administrator,
    });
    await consume(principal, 'MFA_REENROLMENT', reenrolment.token);

    const continuation = await issue({
      principal,
      purpose: 'MFA_ENROLMENT',
      episodeId,
      continuedFromGrantId: reenrolment.grant.id,
    });

    expect(await rowOf(reenrolment.grant.id)).toMatchObject({
      episode_id: episodeId,
      issued_by: administrator,
    });
    expect(await rowOf(continuation.grant.id)).toMatchObject({
      episode_id: episodeId,
      continued_from_grant_id: reenrolment.grant.id,
      supersedes_grant_id: null,
    });
  });

  // Break caught: a continuation issued while the identity holds a live continuation of an earlier grant (a reset after a credential
  // setup, before its first code was proved) naming that live grant as its predecessor as well as its source: two lineage columns on
  // one row, which the table refuses, and the whole act, the consumption of the grant it continues included, rolls back with it.
  it('issues a continuation over a live one: the live one ends, and the new one names its source and no predecessor', async () => {
    const principal = staff();
    const setup = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    await consume(principal, 'STAFF_CREDENTIAL_SETUP', setup.token);
    const live = await issue({
      principal,
      purpose: 'MFA_ENROLMENT',
      continuedFromGrantId: setup.grant.id,
    });
    const episodeId = randomUUID();
    const reenrolment = await issue({
      principal,
      purpose: 'MFA_REENROLMENT',
      episodeId,
      issuedBy: randomUUID(),
    });
    await consume(principal, 'MFA_REENROLMENT', reenrolment.token);

    const next = await issue({
      principal,
      purpose: 'MFA_ENROLMENT',
      episodeId,
      continuedFromGrantId: reenrolment.grant.id,
    });

    // The ended grant is reported, for the event that says so, but the row carries one lineage: its source.
    expect(next.supersededGrantId).toBe(live.grant.id);
    expect(next.grant.supersedesGrantId).toBeNull();
    expect(next.grant.continuedFromGrantId).toBe(reenrolment.grant.id);
    expect((await rowOf(live.grant.id))?.state).toBe('SUPERSEDED');
    expect((await rowOf(next.grant.id))?.state).toBe('PENDING');
    expect(await consume(principal, 'MFA_ENROLMENT', live.token)).toBeNull();
    expect((await consume(principal, 'MFA_ENROLMENT', next.token))?.id).toBe(next.grant.id);
  });

  it('issues a rider’s device grant with the hash of its attestation challenge', async () => {
    const principal: PrincipalRef = { type: 'RIDER', id: randomUUID() };

    const issued = await issue({
      principal,
      purpose: 'RIDER_DEVICE_ENROLMENT',
      attestationChallengeHash: hashOf('challenge'),
    });

    expect(issued.grant.purpose).toBe('RIDER_DEVICE_ENROLMENT');
    expect(
      (
        await observer.one<{ n: number }>(
          `select count(*)::int as n from setup_grant where id = $1 and attestation_challenge_hash is not null`,
          [issued.grant.id],
        )
      )?.n,
    ).toBe(1);
  });

  // Break caught: a request the database would refuse reaching it, or one it would accept that the machine does not allow.
  it.each([
    [
      'a purpose of another principal type',
      { principal: staff(), purpose: 'RIDER_DEVICE_ENROLMENT' },
    ],
    ['an unknown purpose', { principal: staff(), purpose: 'VENDOR_CREDENTIAL_RECOVERY' }],
    [
      'a principal that is not an id',
      { principal: { type: 'STAFF', id: 'not-a-uuid' }, purpose: 'STAFF_CREDENTIAL_SETUP' },
    ],
    [
      'a delivery for a purpose that never travels as a message (the bootstrap secret)',
      { principal: staff(), purpose: 'BOOTSTRAP_SETUP', delivery },
    ],
    [
      'a delivery for the continuation, which is returned in the response',
      { principal: staff(), purpose: 'MFA_ENROLMENT', delivery },
    ],
    [
      'an episode on a purpose that carries none',
      { principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP', episodeId: randomUUID() },
    ],
    [
      'a continuation source on a grant that is not a continuation',
      { principal: staff(), purpose: 'MFA_REENROLMENT', continuedFromGrantId: randomUUID() },
    ],
    [
      'an administrator that is not an id',
      { principal: staff(), purpose: 'MFA_REENROLMENT', issuedBy: 'root' },
    ],
    [
      'a rider grant with no challenge',
      { principal: { type: 'RIDER', id: randomUUID() }, purpose: 'RIDER_DEVICE_ENROLMENT' },
    ],
    [
      'a challenge on a grant that is not a rider’s',
      {
        principal: staff(),
        purpose: 'STAFF_CREDENTIAL_SETUP',
        attestationChallengeHash: hashOf('x'),
      },
    ],
  ] as const)('refuses %s before it writes anything', async (_label, request) => {
    const before = await observer.count('setup_grant');

    await expect(issue(request as unknown as IssueGrantRequest)).rejects.toBeInstanceOf(
      SetupGrantRequestError,
    );

    expect(await observer.count('setup_grant')).toBe(before);
  });

  // Break caught (§13.9a): a grant issued under a context the policy would silently hide its effects from, which reads as "nothing
  // happened" and not as a refusal.
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
        'issue',
        (handle) => store.issue(handle, { principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' }),
      ],
      [
        'consume',
        (handle) =>
          store.consume(handle, {
            principal: staff(),
            purpose: 'STAFF_CREDENTIAL_SETUP',
            token: tokens.issue().token,
          }),
      ],
      [
        'supersedePending',
        (handle) => store.supersedePending(handle, staff(), ['STAFF_CREDENTIAL_SETUP']),
      ],
      ['findById', (handle) => store.findById(handle, randomUUID())],
      ['findByTokenHash', (handle) => store.findByTokenHash(handle, hashOf('x'))],
      ['findLiveByTokenHash', (handle) => store.findLiveByTokenHash(handle, hashOf('x'))],
      ['lockLive', (handle) => store.lockLive(handle, hashOf('x'))],
    ];
    const named = Object.getOwnPropertyNames(SetupGrantStore.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(calls.map(([name]) => name).toSorted()).toEqual(named.toSorted());

    for (const context of wrong) {
      for (const [name, call] of calls) {
        await expect(
          inTransaction((handle) => call(handle), context),
          name,
        ).rejects.toBeInstanceOf(SetupGrantContextError);
      }
    }
  });

  // Break caught (the rule "audit and business mutation in one transaction", applied to the grant and its message): a grant that
  // survives the rollback of the act that issued it, or a message queued for a grant that does not exist.
  it('rolls the grant and its message back with the transaction that issued them', async () => {
    const principal = staff();

    await expect(
      inTransaction(async (handle) => {
        await store.issue(handle, { principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });
        throw new Error('the issuing act failed afterwards');
      }),
    ).rejects.toThrow('the issuing act failed afterwards');

    expect(await observer.count('setup_grant', { principal_id: principal.id })).toBe(0);
    expect(await observer.count('credential_delivery_job')).toBe(0);
  });
});

describe('the message that carries a grant', () => {
  // Break caught (§13.9a: "the grant is written hash-only beside an encrypted job in one transaction"): a message with no grant, a
  // job that serves another record, a destination or a token readable in the job, or an end that is not the grant's.
  it('is queued in the same transaction, serving the grant, ending when it ends, holding the token only sealed', async () => {
    const principal = staff();

    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });

    expect(issued.job).not.toBeNull();
    const job = await jobOf(issued.grant.id);
    expect(job).toMatchObject({ state: 'QUEUED', kind: 'SETUP_GRANT' });
    expect(
      Math.abs((job?.expires_at.getTime() ?? 0) - (issued.grant.expiresAt?.getTime() ?? -1)),
    ).toBeLessThan(2);
    const text = JSON.stringify(
      await observer.rows(
        `select j::text from credential_delivery_job j where redemption_record_id = $1`,
        [issued.grant.id],
      ),
    );
    expect(text).not.toContain(issued.token);
    expect(text).not.toContain(SENTINEL_DESTINATION);
    expect(
      await observer.one<{ type: string; principal: string }>(
        `select redemption_record_type as type, principal_id as principal from credential_delivery_job where redemption_record_id = $1`,
        [issued.grant.id],
      ),
    ).toEqual({ type: 'SETUP_GRANT', principal: principal.id });
  });

  it('queues nothing for a grant that is issued without a delivery', async () => {
    const issued = await issue({ principal: staff(), purpose: 'MFA_REENROLMENT' });

    expect(issued.job).toBeNull();
    expect(await jobOf(issued.grant.id)).toBeUndefined();
  });

  // Break caught (§6.8: "superseding ... cancels its job"): the earlier message left live after its grant is replaced, so that a link
  // that redemption already refuses is still sent.
  it('cancels the message of the grant it supersedes and queues one for the new grant', async () => {
    const principal = staff();
    const first = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });

    const second = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });

    expect(await jobOf(first.grant.id)).toMatchObject({
      state: 'CANCELLED',
      outcome_class: 'CANCELLED',
    });
    expect(await jobOf(second.grant.id)).toMatchObject({ state: 'QUEUED' });
  });

  // Break caught: a message that outlives the grant it served.
  it('cancels the message of a grant when the grant is consumed', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });

    await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token);

    expect(await jobOf(issued.grant.id)).toMatchObject({ state: 'CANCELLED' });
  });

  // Break caught: a message that cannot be queued leaving the grant behind. The issuing act fails whole.
  it('fails the whole issue when the message cannot be queued', async () => {
    const principal = staff();

    await expect(
      issue({
        principal,
        purpose: 'STAFF_CREDENTIAL_SETUP',
        delivery: { ...delivery, destination: 'not an address' },
      }),
    ).rejects.toThrow(/credential message could not be queued/);

    expect(await observer.count('setup_grant', { principal_id: principal.id })).toBe(0);
  });
});

describe('consuming a grant', () => {
  // Break caught (§6.8: "single use"): a grant consumed twice, or a consumption that leaves the state as it was.
  it('consumes a grant once, at the database’s time, and never again', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });

    const consumed = await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token);

    expect(consumed).toMatchObject({ id: issued.grant.id, state: 'CONSUMED' });
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
    expect(await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token)).toBeNull();
    expect((await rowOf(issued.grant.id))?.state).toBe('CONSUMED');
  });

  // Break caught (AC-88, "two completions of one grant have one winner"): the check and the write apart, so that two requests that
  // present the one token both pass the check.
  it('has one winner when two transactions present the same token together', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token)),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await rowOf(issued.grant.id))?.state).toBe('CONSUMED');
  });

  // Break caught (§6.8: "purpose-bound and principal-bound"): a grant for one act presented for another, or for another person.
  it('does not consume a grant presented for another purpose or by another principal', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });

    expect(await consume(principal, 'MFA_ENROLMENT', issued.token)).toBeNull();
    expect(await consume(staff(), 'STAFF_CREDENTIAL_SETUP', issued.token)).toBeNull();
    // A vendor account that happens to carry the same id is another principal, even presenting the staff grant's own token.
    expect(
      await consume({ type: 'VENDOR', id: principal.id }, 'VENDOR_CREDENTIAL_SETUP', issued.token),
    ).toBeNull();
    expect((await rowOf(issued.grant.id))?.state).toBe('PENDING');
    expect((await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token))?.id).toBe(
      issued.grant.id,
    );
  });

  // Break caught: a malformed or unknown token reaching the table as a lookup, which would make an oracle of an error message.
  it('finds nothing for a token that is not well formed or was never issued', async () => {
    const principal = staff();

    for (const token of ['', 'short', 'x'.repeat(43), `${'A'.repeat(42)}=`, tokens.issue().token]) {
      expect(await consume(principal, 'STAFF_CREDENTIAL_SETUP', token), token).toBeNull();
    }
  });

  // Break caught (the plan's rule "valid means now < expires_at", judged on one fresh database value): an app clock, or an expired
  // grant redeemed.
  it('does not consume a grant whose expiry has passed on the database’s clock', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    await age(issued.grant.id, 60);

    expect(await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token)).toBeNull();
    expect((await rowOf(issued.grant.id))?.state).toBe('PENDING');
  });

  it('judges the expiry at the instant itself: equality is expired', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    await admin.query('alter table setup_grant disable trigger setup_grant_update_guard');
    try {
      await admin.query(`update setup_grant set expires_at = clock_timestamp() where id = $1`, [
        issued.grant.id,
      ]);
    } finally {
      await admin.query('alter table setup_grant enable trigger setup_grant_update_guard');
    }

    expect(await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token)).toBeNull();
  });

  // Break caught: the bootstrap secret expiring, which would strand provisioning (§6.8: "a clock that can strand provisioning").
  it('consumes a BOOTSTRAP_SETUP grant however long it has waited', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'BOOTSTRAP_SETUP' });
    await admin.query('alter table setup_grant disable trigger setup_grant_update_guard');
    try {
      await admin.query(
        `update setup_grant set issued_at = issued_at - interval '5 years' where id = $1`,
        [issued.grant.id],
      );
    } finally {
      await admin.query('alter table setup_grant enable trigger setup_grant_update_guard');
    }

    expect((await consume(principal, 'BOOTSTRAP_SETUP', issued.token))?.id).toBe(issued.grant.id);
  });

  // Break caught: a consumption that survives the rollback of the act it was for ("a proof is never spent on an act that did not
  // happen").
  it('is rolled back with the transaction that consumed it', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });

    await expect(
      inTransaction(async (handle) => {
        await store.consume(handle, {
          principal,
          purpose: 'STAFF_CREDENTIAL_SETUP',
          token: issued.token,
        });
        throw new Error('the act failed afterwards');
      }),
    ).rejects.toThrow('the act failed afterwards');

    expect((await rowOf(issued.grant.id))?.state).toBe('PENDING');
    expect((await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token))?.id).toBe(
      issued.grant.id,
    );
  });
});

/**
 * A grant whose expiry has passed is still `PENDING` (nothing rewrites it until the next issue), so "the state is PENDING" is not "the
 * grant can be used": `findLiveByTokenHash` and `lockLive` judge the expiry on the database's clock (the audit of 21 October 2026, A02).
 */
describe('a grant that can be used now', () => {
  /** Sets the expiry of a grant, as the administrator past the guard that forbids it. */
  async function expireAt(id: string, expiresAtSql: string): Promise<void> {
    await admin.query('alter table setup_grant disable trigger setup_grant_update_guard');
    try {
      await admin.query(
        `update setup_grant set issued_at = ${expiresAtSql} - interval '31 minutes', expires_at = ${expiresAtSql} where id = $1`,
        [id],
      );
    } finally {
      await admin.query('alter table setup_grant enable trigger setup_grant_update_guard');
    }
  }

  const liveBy = (token: string) =>
    inTransaction((handle) =>
      store.findLiveByTokenHash(handle, tokens.hash(token) ?? new Uint8Array(32)),
    );
  const lockedBy = (token: string) =>
    inTransaction((handle) => store.lockLive(handle, tokens.hash(token) ?? new Uint8Array(32)));

  // Break caught: a state alone taken for liveness, which lets an expired grant through to the work that a live one is owed.
  it('finds a live grant, and not one that is consumed, superseded, past its expiry or unknown', async () => {
    const principal = staff();
    const live = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    const bootstrap = await issue({ principal: staff(), purpose: 'BOOTSTRAP_SETUP' });
    const consumed = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });
    await consume(
      { type: 'STAFF', id: consumed.grant.principalId },
      'STAFF_CREDENTIAL_SETUP',
      consumed.token,
    );
    const replaced = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });
    await issue({
      principal: { type: 'STAFF', id: replaced.grant.principalId },
      purpose: 'STAFF_CREDENTIAL_SETUP',
    });
    const expired = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });
    await expireAt(expired.grant.id, "clock_timestamp() - interval '1 minute'");

    expect((await liveBy(live.token))?.id).toBe(live.grant.id);
    // a grant with no expiry (the bootstrap secret) is live for as long as it is pending
    expect((await liveBy(bootstrap.token))?.id).toBe(bootstrap.grant.id);
    for (const token of [consumed.token, replaced.token, expired.token, tokens.issue().token]) {
      expect(await liveBy(token)).toBeNull();
    }
    expect((await lockedBy(live.token))?.id).toBe(live.grant.id);
    for (const token of [consumed.token, replaced.token, expired.token, tokens.issue().token]) {
      expect(await lockedBy(token)).toBeNull();
    }
    // the expired grant was not rewritten by being looked at
    expect((await rowOf(expired.grant.id))?.state).toBe('PENDING');
  });

  // Break caught: the time read in the statement that takes the lock, which is read before the wait for it. The lock is held on a row
  // that nobody changes, so the statement does not run again after the wait: a grant that expires meanwhile must still be refused.
  it('judges the expiry on the time after a wait for a lock held on an unchanged row', async () => {
    const lapsing = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });
    const lasting = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });
    await expireAt(lapsing.grant.id, "clock_timestamp() + interval '1200 milliseconds'");
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(
        'select id from setup_grant where id = any($1::uuid[]) for no key update',
        [[lapsing.grant.id, lasting.grant.id]],
      );
      const waiting = Promise.all([lockedBy(lapsing.token), lockedBy(lasting.token)]);
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      await holder.query('commit');

      const [lapsed, kept] = await waiting;
      expect(lapsed).toBeNull();
      expect(kept?.id).toBe(lasting.grant.id);
    } finally {
      await holder.end();
    }
  });
});

describe('ending the live grants of a principal', () => {
  // Break caught (§6.8: "offboarding ends its PENDING grants the same way (SUPERSEDED) and cancels their delivery jobs ... a grant
  // already past PENDING keeps its state"): a terminal grant rewritten, a lapsed grant called superseded, another purpose ended.
  it('supersedes the live grants of the named purposes, expires the lapsed, cancels their messages and touches nothing else', async () => {
    const principal = staff();
    const live = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });
    const continuation = await issue({ principal, purpose: 'MFA_ENROLMENT' });
    const other = await issue({ principal, purpose: 'BOOTSTRAP_SETUP' });
    const consumed = await issue({ principal, purpose: 'MFA_REENROLMENT' });
    await consume(principal, 'MFA_REENROLMENT', consumed.token);
    const lapsed = await issue({ principal, purpose: 'MFA_REENROLMENT' });
    await age(lapsed.grant.id, 60);

    const ended = await inTransaction((handle) =>
      store.supersedePending(handle, principal, [
        'STAFF_CREDENTIAL_SETUP',
        'MFA_ENROLMENT',
        'MFA_REENROLMENT',
      ]),
    );

    expect(ended.superseded.toSorted()).toEqual([live.grant.id, continuation.grant.id].toSorted());
    expect(ended.expired).toEqual([lapsed.grant.id]);
    expect((await rowOf(live.grant.id))?.state).toBe('SUPERSEDED');
    expect((await rowOf(continuation.grant.id))?.state).toBe('SUPERSEDED');
    expect((await rowOf(lapsed.grant.id))?.state).toBe('EXPIRED');
    expect((await rowOf(consumed.grant.id))?.state).toBe('CONSUMED');
    expect((await rowOf(other.grant.id))?.state).toBe('PENDING');
    expect(await jobOf(live.grant.id)).toMatchObject({ state: 'CANCELLED' });
  });

  it('returns nothing, and writes nothing, when there is nothing live', async () => {
    const ended = await inTransaction((handle) =>
      store.supersedePending(handle, staff(), ['STAFF_CREDENTIAL_SETUP']),
    );

    expect(ended).toEqual({ superseded: [], expired: [] });
  });

  it('refuses a purpose that is not the principal’s', async () => {
    await expect(
      inTransaction((handle) =>
        store.supersedePending(handle, staff(), ['RIDER_DEVICE_ENROLMENT']),
      ),
    ).rejects.toBeInstanceOf(SetupGrantRequestError);
  });
});

describe('what the store offers', () => {
  // Break caught (GBT-E5, the port half: "by-key lookups and no list or scan method"): a method that lists or scans grants, which the
  // authentication capability's policy would allow it to run across every principal's rows.
  it('has lookups by the key a request presents and no list or scan', () => {
    const methods = Object.getOwnPropertyNames(SetupGrantStore.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(methods.toSorted()).toEqual([
      'consume',
      'findById',
      'findByTokenHash',
      'findLiveByTokenHash',
      'issue',
      'lockLive',
      'supersedePending',
    ]);
    for (const name of methods)
      expect(name).not.toMatch(/^(list|all|scan|search|query|each|every|export)/i);
  });

  it('finds a grant by its id and by its token hash, and reads no hash back', async () => {
    const issued = await issue({ principal: staff(), purpose: 'STAFF_CREDENTIAL_SETUP' });

    const byId = await inTransaction((handle) => store.findById(handle, issued.grant.id));
    const missing = await inTransaction((handle) => store.findById(handle, randomUUID()));
    const malformed = inTransaction((handle) => store.findById(handle, 'not-a-uuid'));

    expect(byId).toEqual(issued.grant);
    expect(missing).toBeNull();
    await expect(malformed).rejects.toBeInstanceOf(TypeError);
    expect(Object.keys(byId ?? {})).not.toContain('tokenHash');
  });
});

describe('secrets', () => {
  // Break caught (plan section 3, "Secrets"): a token in an error, a log line or a query the pool logged.
  it('puts no token in an error that a refusal raises or in the database’s own log of the statements', async () => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP', delivery });
    const failure = await inTransaction((handle) =>
      store.issue(handle, {
        principal,
        purpose: 'BOOTSTRAP_SETUP',
        delivery,
      } as unknown as IssueGrantRequest),
    ).catch((error: unknown) => error);

    expect((failure as Error).message).not.toContain(issued.token);
    expect(JSON.stringify(failure)).not.toContain(issued.token);
    expect(JSON.stringify(failure)).not.toContain(SENTINEL_DESTINATION);
    expect(api.logs.text()).not.toContain(issued.token);
    expect(api.logs.text()).not.toContain(SENTINEL_DESTINATION);
  });
});

/**
 * A consumption whose `where` passed and whose expiry passed before the table's guard looked at the row (the audit of 21 October 2026,
 * A06): the guard refuses it, the statement fails and the transaction with it. The store raises that refusal, and only that one, as
 * `SetupGrantExpiredError`; the race is made by a trigger that sleeps in front of the guard, and it counts the times it was reached, so
 * that a test cannot pass because the expiry came early and was refused somewhere else.
 */
describe('a consumption that meets the expiry after its own check', () => {
  const EXPIRES_IN_SECONDS = 2.5;
  const DELAY_SECONDS = 3.2;

  async function lapsingGrant(): Promise<{ principal: PrincipalRef; token: string; id: string }> {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    await admin.query('alter table setup_grant disable trigger setup_grant_update_guard');
    try {
      await admin.query(
        `with t as (select clock_timestamp() + make_interval(secs => $2) as at)
         update setup_grant set issued_at = t.at - interval '31 minutes', expires_at = t.at from t where id = $1`,
        [issued.grant.id, EXPIRES_IN_SECONDS],
      );
    } finally {
      await admin.query('alter table setup_grant enable trigger setup_grant_update_guard');
    }
    return { principal, token: issued.token, id: issued.grant.id };
  }

  // Break caught: the guard's refusal escaping as a generic database failure (an answer of 500 for an ordinary race), or the grant left
  // consumed by a transaction that did not commit.
  it('is raised as the expiry of the grant, and the grant stays as it was', async () => {
    const lapsing = await lapsingGrant();
    const race = await delayConsumption(
      (statement) => admin.query(statement),
      'setup_grant',
      DELAY_SECONDS,
    );
    try {
      await expect(
        consume(lapsing.principal, 'STAFF_CREDENTIAL_SETUP', lapsing.token),
      ).rejects.toBeInstanceOf(SetupGrantExpiredError);
      expect(await race.hits()).toBe(1);
    } finally {
      await race.remove();
    }

    expect((await rowOf(lapsing.id))?.state).toBe('PENDING');
  });

  // Break caught: any check violation of the table taken for the expiry (a defect answered as a link that merely lapsed), or the reason
  // of the other table's guard taken for this one's.
  it.each([
    ['states no reason', null, undefined],
    ['states another reason', 'reason=SOMETHING_ELSE', undefined],
    ['states the reason of the challenge table', 'reason=CHALLENGE_EXPIRED', undefined],
    ['states the reason of an expiry', 'reason=GRANT_EXPIRED', SetupGrantExpiredError],
  ])('treats a refusal that %s as what it is', async (_name, detail, typed) => {
    const principal = staff();
    const issued = await issue({ principal, purpose: 'STAFF_CREDENTIAL_SETUP' });
    const race = await refuseConsumption(
      (statement) => admin.query(statement),
      'setup_grant',
      detail,
    );
    let failure: unknown;
    try {
      failure = await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(await race.hits()).toBe(1);
    } finally {
      await race.remove();
    }

    expect(failure).toBeInstanceOf(Error);
    if (typed === undefined) {
      expect(failure).not.toBeInstanceOf(SetupGrantExpiredError);
      expect(serverErrorIn(failure)?.code).toBe('23514');
    } else {
      expect(failure).toBeInstanceOf(typed);
    }
    expect((await rowOf(issued.grant.id))?.state).toBe('PENDING');
    expect((await consume(principal, 'STAFF_CREDENTIAL_SETUP', issued.token))?.id).toBe(
      issued.grant.id,
    );
  });
});
