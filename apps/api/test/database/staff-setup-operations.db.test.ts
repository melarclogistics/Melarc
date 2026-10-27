import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hotp } from '../../src/platform/auth/crypto/hotp.js';
import { Sha256TokenService } from '../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import {
  HASH_ADMISSION,
  type HashAdmission,
  type HashSlot,
} from '../../src/platform/auth/ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { TRUSTED_BROWSER_STORE } from '../../src/platform/auth/trusted-browsers/trusted-browser-providers.js';
import type { TrustedBrowserStore } from '../../src/platform/auth/trusted-browsers/trusted-browser-store.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../../src/staff/reserved-system-actor.js';
import type { RequestOptions, TestResponse } from '../../src/test-support/test-client.js';
import { decodeBase32 } from '../../src/test-support/base32.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { grantRow, insertGrant, setGrantState, type GrantRow } from './support/credentials.js';
import { delayConsumption, refuseConsumption } from './support/guard-race.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { backendPidOf, waitUntilBlockedBy, waitUntilTrue } from './support/lock-wait.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S0.31, the three credential setup operations against the real application and a real PostgreSQL (`completeStaffCredentialSetup`,
 * `completeMfaEnrolment`, `beginMfaReenrolment`): every request is a real HTTP request from the test client of the kit, as a page of
 * the Ops Portal makes it, to the application as it ships and connected as `melarc_api_runtime`. Grants and identities are arranged as
 * the administrator (the operations that issue them are later tasks); what each operation did is read back from a second connection.
 *
 * The identities here are throwaway rows of a disposable database, and every secret is made for the test.
 */

const OPS = 'http://127.0.0.1:5173';
const SETUP = '/api/v1/auth/staff/setup';
const CREDENTIAL = `${SETUP}/credential`;
const MFA = `${SETUP}/mfa`;
const BEGIN = `${SETUP}/mfa/begin`;

const PASSWORD = 'correct horse battery staple';
const tokens = new Sha256TokenService();

let database: TestDatabase;
let kit: IntegrationKit;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  // The races of this file hold a row lock until the test has seen the request wait for it (and, for a grant that lapses, until the database's
  // clock says so): the test ends the wait and not a bound, so the database's lock bound is lengthened for this application alone. Nothing
  // here tests a timeout, and the bounds of production are untouched (the audit of 26 October 2026, decision 9).
  kit = await startIntegrationKit(database, {
    poolMax: 4,
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '10000',
      DATABASE_STATEMENT_TIMEOUT_MS: '12000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '15000',
    },
  });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await kit.stop();
  await database.drop();
});

/** The application's own hasher, found when a test asks (the application binds it, and a test of a missing one fails alone). */
const hasher: Pick<Hasher, 'verify'> = {
  verify: (kind, secret, encoded) =>
    kit.app.app.get<Hasher>(HASHER, { strict: false }).verify(kind, secret, encoded),
};

const post = (path: string, body: unknown, options: RequestOptions = {}): Promise<TestResponse> =>
  kit.client.post(path, body, { origin: OPS, ...options });

/** An `ACTIVE` identity that holds no credential yet, which is what a setup grant is issued to. */
const identity = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(
    admin,
    staffRow({ credentialHash: null, credentialEstablishedAt: null, ...overrides }),
  );

const privileged = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  identity({ roleBundleId: BUNDLE_IDS.seniorOps, ...overrides });

/** A `PENDING` grant, with the token that opens it: the token is made here and only its hash is stored, as the store does. */
async function grant(
  principalId: string,
  purpose = 'STAFF_CREDENTIAL_SETUP',
  overrides: Partial<GrantRow> = {},
): Promise<{ token: string; id: string }> {
  const issued = tokens.issue();
  const row = await insertGrant(
    admin,
    grantRow({ principalId, purpose, tokenHash: Buffer.from(issued.hash), ...overrides }),
  );
  return { token: issued.token, id: row.id };
}

const bootstrapIdentity = (): Promise<StaffRow> =>
  privileged({
    roleBundleId: BUNDLE_IDS.platformAdmin,
    origin: 'BOOTSTRAP',
    createdBy: RESERVED_SYSTEM_ACTOR_ID,
    approvedBy: RESERVED_SYSTEM_ACTOR_ID,
  });

interface IdentityFacts {
  generation: string;
  hash: string | null;
  established: Date | null;
}

async function identityFacts(id: string): Promise<IdentityFacts> {
  const row = await kit.observe.one<{
    generation: string;
    hash: string | null;
    established: Date | null;
  }>(
    `select credential_generation as generation, credential_hash as hash, credential_established_at as established
       from staff_identity where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('the identity is not there');
  return row;
}

const grantState = async (id: string): Promise<string | undefined> =>
  (await kit.observe.one<{ state: string }>('select state from setup_grant where id = $1', [id]))
    ?.state;

const factorsOf = (identityId: string) =>
  kit.observe.rows<{
    id: string;
    status: string;
    created_by_purpose: string;
    created_episode_id: string | null;
    enrolled_at: Date | null;
    last_verified_counter: string | null;
    secret_ciphertext: Buffer;
  }>(
    `select id, status, created_by_purpose, created_episode_id, enrolled_at, last_verified_counter, secret_ciphertext
       from mfa_factor where staff_identity_id = $1 order by id`,
    [identityId],
  );

const grantsOf = (principalId: string) =>
  kit.observe.rows<{
    id: string;
    purpose: string;
    state: string;
    continued_from_grant_id: string | null;
    episode_id: string | null;
    issued_at: Date;
    expires_at: Date | null;
  }>(
    `select id, purpose, state, continued_from_grant_id, episode_id, issued_at, expires_at
       from setup_grant where principal_id = $1 order by id`,
    [principalId],
  );

const sessionsOf = (id: string): Promise<number> =>
  kit.observe.count('session', { principal_type: 'STAFF', principal_id: id });

interface AuditFacts {
  event_code: string;
  enhanced: boolean;
  outcome: string;
  actor_type: string;
  actor_id: string | null;
  surface_context: string;
  object_type: string;
  object_id: string | null;
  detail: Record<string, unknown>;
  before_after: Record<string, unknown> | null;
  related_ids: Record<string, unknown> | null;
  correlation_id: string;
}

/** The events about an identity or about any of its grants and factors, oldest first. */
const auditAbout = async (identityId: string): Promise<AuditFacts[]> =>
  kit.observe.rows<AuditFacts>(
    `select event_code, enhanced, outcome, actor_type, actor_id, surface_context, object_type, object_id, detail, before_after,
            related_ids, correlation_id
       from audit_event
      where object_id = $1::uuid
         or related_ids ->> 'principal_id' = $1::uuid::text
         or object_id in (select id from setup_grant where principal_id = $1::uuid)
         or object_id in (select id from mfa_factor where staff_identity_id = $1::uuid)`,
    [identityId],
  );

/** The event codes, in alphabetical order: the events of one transaction share an instant, so no order between them is asserted. */
const codesOf = (events: readonly AuditFacts[]): string[] =>
  events.map((event) => event.event_code).toSorted();

const eventOf = (events: readonly AuditFacts[], code: string): AuditFacts => {
  const found = events.find((event) => event.event_code === code);
  if (found === undefined) throw new Error(`no ${code} event was written`);
  return found;
};

/** The TOTP code an authenticator holding `seed` shows now, on the clock the application was given. */
function codeFor(seed: Uint8Array, stepOffset = 0): string {
  const step = Math.floor(kit.clock.now().getTime() / 30_000) + stepOffset;
  return hotp(seed, step, 6);
}

/** A well-formed code that is none of the three the verifier accepts now (the step before, this one, the step after). */
function wrongCode(seed: Uint8Array): string {
  const accepted = new Set([-1, 0, 1].map((offset) => codeFor(seed, offset)));
  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const text = String(candidate).padStart(6, '0');
    if (!accepted.has(text)) return text;
  }
  throw new Error('no wrong code exists');
}

interface Provisioned {
  uri: string;
  seed: Uint8Array;
  mfaToken: string;
}

function provisioningOf(response: TestResponse): Provisioned {
  const body = response.json() as {
    mfa_provisioning: { otpauth_uri: string };
    mfa_setup_token: string;
  };
  const secret = new URL(body.mfa_provisioning.otpauth_uri).searchParams.get('secret') ?? '';
  return {
    uri: body.mfa_provisioning.otpauth_uri,
    seed: decodeBase32(secret),
    mfaToken: body.mfa_setup_token,
  };
}

/** A privileged identity taken through the first operation: what the second operation starts from. */
async function awaitingProof(overrides: Partial<StaffRow> = {}) {
  const row = await privileged(overrides);
  const { token, id } = await grant(row.id);
  const response = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });
  expect(response.status).toBe(200);
  return { row, originGrantId: id, ...provisioningOf(response) };
}

/**
 * Runs a request while another transaction holds the identity's row lock and has changed the identity, and commits that change a moment
 * later. The request's first look (taken with no lock) sees the identity as it was; what it decides under the lock sees it as it is.
 */
async function raceAgainstChange(
  identityId: string,
  change: string,
  request: () => Promise<TestResponse>,
  /** What the test needs to be true, on the database's clock, before the lock is let go: a grant's end having passed, for instance. */
  whileWaiting?: (observer: pg.Client) => Promise<void>,
): Promise<TestResponse> {
  const holder = clientFor(database.urlFor('postgres'));
  const observer = clientFor(database.urlFor('postgres'));
  await holder.connect();
  await observer.connect();
  try {
    await holder.query('begin');
    await holder.query('select id from staff_identity where id = $1 for no key update', [
      identityId,
    ]);
    await holder.query(change, [identityId]);
    const pending = request();
    // Committed when the request is seen waiting for the lock, and not after a time it may or may not have taken (audit of 26 October 2026,
    // decision 9).
    await waitUntilBlockedBy(observer, await backendPidOf(holder), 'the request', pending);
    await whileWaiting?.(observer);
    await holder.query('commit');
    return await pending;
  } finally {
    await holder.end();
    await observer.end();
  }
}

/**
 * For `raceAgainstChange`: the grant was still live when the request was seen waiting (so that the request really did look at a live
 * grant, and a slow machine cannot turn the test into a look at an expired one), and its end has passed on the database's clock before the
 * lock is let go. The test waits for that moment and does not sleep for it.
 */
const lapsesWhileWaiting =
  (grantId: string) =>
  async (observer: pg.Client): Promise<void> => {
    const live = await observer.query<{ ready: boolean }>(
      'select clock_timestamp() < expires_at as ready from setup_grant where id = $1',
      [grantId],
    );
    expect(live.rows[0]?.ready, 'the grant was still live when the request began to wait').toBe(
      true,
    );
    await waitUntilTrue(
      observer,
      'select clock_timestamp() > expires_at as ready from setup_grant where id = $1',
      [grantId],
      'the end of the grant',
    );
  };

const SUSPEND = "update staff_identity set status = 'SUSPENDED' where id = $1";

const SETUP_GRANT_INVALID = { code: 'SETUP_GRANT_INVALID' };

describe('completeStaffCredentialSetup: an ordinary member of Ops Staff', () => {
  // Break caught: a response that carries a session, a cookie or a body that the browser may cache; a credential stored in any form
  // but the Argon2id hash of the NFKC text; the grant left open after the password was set.
  it('establishes the password, consumes the grant and issues neither a session nor a cookie', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id);

    const response = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ authentication_ready: true, mfa_enrolment_required: false });
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.header('set-cookie')).toBeNull();
    expect(response.setCookies).toEqual([]);

    const facts = await identityFacts(row.id);
    expect(facts.generation).toBe('1');
    expect(facts.established).toBeInstanceOf(Date);
    expect(facts.hash).toMatch(/^\$argon2id\$/);
    expect(facts.hash).not.toContain(PASSWORD);
    expect((await hasher.verify('STAFF_PASSWORD', PASSWORD, facts.hash ?? '')).matches).toBe(true);
    expect((await hasher.verify('STAFF_PASSWORD', `${PASSWORD}!`, facts.hash ?? '')).matches).toBe(
      false,
    );
    expect(await grantState(id)).toBe('CONSUMED');
    expect(await sessionsOf(row.id)).toBe(0);
    expect(await factorsOf(row.id)).toEqual([]);
    expect((await grantsOf(row.id)).map((each) => each.purpose)).toEqual([
      'STAFF_CREDENTIAL_SETUP',
    ]);
  });

  // Break caught: a password hashed as typed (the sign-in hashes the NFKC form, so a user who set a compatibility form would never
  // be able to sign in), or normalised in the response path only.
  it('hashes the NFKC form of the password, the form the sign-in will hash', async () => {
    const row = await identity();
    const { token } = await grant(row.id);
    const typed = 'ﬁnal ﬁnish ﬁne'; // 14 code points as sent, 17 after NFKC

    expect((await post(CREDENTIAL, { setup_token: token, password: typed })).status).toBe(200);

    const { hash } = await identityFacts(row.id);
    expect(
      (await hasher.verify('STAFF_PASSWORD', typed.normalize('NFKC'), hash ?? '')).matches,
    ).toBe(true);
    expect((await hasher.verify('STAFF_PASSWORD', typed, hash ?? '')).matches).toBe(false);
  });

  it('writes the audit events of the act, as the person whose credential it was, and no secret', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id);

    await post(CREDENTIAL, { setup_token: token, password: PASSWORD });

    const events = await auditAbout(row.id);
    expect(codesOf(events)).toEqual(['auth.credential.changed', 'auth.setup_grant.consumed']);
    const consumed = eventOf(events, 'auth.setup_grant.consumed');
    const changed = eventOf(events, 'auth.credential.changed');
    expect(consumed).toMatchObject({
      object_type: 'SetupGrant',
      object_id: id,
      outcome: 'SUCCEEDED',
      enhanced: false,
      actor_type: 'STAFF',
      actor_id: row.id,
    });
    expect(consumed.detail).toMatchObject({ purpose: 'STAFF_CREDENTIAL_SETUP' });
    expect(changed).toMatchObject({
      object_type: 'StaffIdentity',
      object_id: row.id,
      outcome: 'SUCCEEDED',
      actor_type: 'STAFF',
      actor_id: row.id,
    });
    expect(changed.detail).toMatchObject({ cause: 'SETUP' });
    const everything = JSON.stringify(events);
    for (const secret of [PASSWORD, token]) expect(everything).not.toContain(secret);
    expect(kit.app.logs.text()).not.toContain(PASSWORD);
    expect(kit.app.logs.text()).not.toContain(token);
  });

  it('accepts a password of exactly 12 lower-case letters and a passphrase of 128 characters with spaces', async () => {
    const short = await identity();
    const long = await identity();
    const shortGrant = await grant(short.id);
    const longGrant = await grant(long.id);
    const passphrase = `${'a b c '.repeat(21)}ab`; // 128 code points, spaces kept

    expect(passphrase).toHaveLength(128);
    expect(
      (await post(CREDENTIAL, { setup_token: shortGrant.token, password: 'abcdefghijkl' })).status,
    ).toBe(200);
    expect(
      (await post(CREDENTIAL, { setup_token: longGrant.token, password: passphrase })).status,
    ).toBe(200);
    const { hash } = await identityFacts(long.id);
    expect((await hasher.verify('STAFF_PASSWORD', passphrase, hash ?? '')).matches).toBe(true);
  });

  it('serves the bootstrap secret too, which has no expiry', async () => {
    const row = await bootstrapIdentity();
    const { token, id } = await grant(row.id, 'BOOTSTRAP_SETUP');

    const response = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(await grantState(id)).toBe('CONSUMED');
    expect((await identityFacts(row.id)).generation).toBe('1');
  });
});

describe('completeStaffCredentialSetup: the grant is refused alike for every reason', () => {
  async function refusal(
    token: string,
    password = PASSWORD,
  ): Promise<{ status: number; code: unknown; message: unknown }> {
    const response = await post(CREDENTIAL, { setup_token: token, password });
    const body = response.json() as { code: unknown; message: unknown };
    return { status: response.status, code: body.code, message: body.message };
  }

  // Break caught: a refusal whose status, code or message tells the caller which of the ways a grant can be unusable this was
  // (state-machines.md §19: which of them it was is not for a caller to learn).
  it('answers 422 SETUP_GRANT_INVALID, with one message, for each way a grant is unusable', async () => {
    const unknown = (await refusal(tokens.issue().token)).message;
    const answers: { name: string; answer: Awaited<ReturnType<typeof refusal>> }[] = [];

    answers.push({ name: 'malformed', answer: await refusal('not-a-token') });

    const expired = await identity();
    // A grant keeps everything but its state, so a lapsed one is inserted lapsed (issued two hours ago, expired an hour ago).
    const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);
    const expiredGrant = await grant(expired.id, 'STAFF_CREDENTIAL_SETUP', {
      issuedAt: hoursAgo(2),
      expiresAt: hoursAgo(1),
    });
    answers.push({ name: 'expired', answer: await refusal(expiredGrant.token) });

    const spent = await identity();
    const spentGrant = await grant(spent.id);
    await setGrantState(admin, spentGrant.id, 'CONSUMED');
    answers.push({ name: 'consumed', answer: await refusal(spentGrant.token) });

    const replaced = await identity();
    const replacedGrant = await grant(replaced.id);
    await setGrantState(admin, replacedGrant.id, 'SUPERSEDED');
    answers.push({ name: 'superseded', answer: await refusal(replacedGrant.token) });

    const orphan = await grant(randomUUID());
    answers.push({ name: 'orphan', answer: await refusal(orphan.token) });

    // A real vendor account, which the vendor guard (0035) requires of a vendor grant.
    const account = (await insertVendor(admin, vendorRow())).accountId;
    const vendor = await grant(account, 'VENDOR_CREDENTIAL_SETUP', { principalType: 'VENDOR' });
    answers.push({ name: 'another kind of principal', answer: await refusal(vendor.token) });

    const credentialed = await identity({
      credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
    });
    const credentialedGrant = await grant(credentialed.id);
    answers.push({ name: 'already credentialed', answer: await refusal(credentialedGrant.token) });

    const suspended = await identity({ status: 'SUSPENDED' });
    const suspendedGrant = await grant(suspended.id);
    answers.push({ name: 'suspended', answer: await refusal(suspendedGrant.token) });

    const offboarded = await identity({ status: 'OFFBOARDED' });
    const offboardedGrant = await grant(offboarded.id);
    answers.push({ name: 'offboarded', answer: await refusal(offboardedGrant.token) });

    for (const { name, answer } of answers) {
      expect({ name, ...answer }).toEqual({
        name,
        status: 422,
        code: 'SETUP_GRANT_INVALID',
        message: unknown,
      });
    }
    // Nothing was written by any of them.
    expect((await identityFacts(expired.id)).generation).toBe('0');
    expect(await grantState(expiredGrant.id)).toBe('PENDING');
    expect(await grantState(spentGrant.id)).toBe('CONSUMED');
    expect((await identityFacts(credentialed.id)).generation).toBe('1');
    expect((await identityFacts(suspended.id)).generation).toBe('0');
    expect(await grantState(suspendedGrant.id)).toBe('PENDING');
  });

  // Break caught: an MFA continuation or a re-enrolment authorisation accepted as a setup grant (it would set a password on the
  // strength of a grant that was never issued for that).
  it('refuses a grant of another purpose and does not consume it', async () => {
    const proof = await awaitingProof();
    const other = await identity();
    const reenrolment = await grant(other.id, 'MFA_REENROLMENT', { episodeId: randomUUID() });

    expect(await refusal(proof.mfaToken)).toMatchObject({
      status: 422,
      code: 'SETUP_GRANT_INVALID',
    });
    expect(await refusal(reenrolment.token)).toMatchObject({
      status: 422,
      code: 'SETUP_GRANT_INVALID',
    });

    expect(await grantState(reenrolment.id)).toBe('PENDING');
    expect(
      (await grantsOf(proof.row.id)).find((each) => each.purpose === 'MFA_ENROLMENT')?.state,
    ).toBe('PENDING');
    expect((await identityFacts(other.id)).generation).toBe('0');
  });

  it('refuses a grant issued for one employee at the credential of another: the principal comes from the grant alone', async () => {
    const owner = await identity();
    const other = await identity();
    const { token } = await grant(owner.id);

    const response = await post(CREDENTIAL, {
      setup_token: token,
      password: PASSWORD,
      staff_identity_id: other.id,
    });

    expect(response.status).toBe(400);
    expect((await identityFacts(owner.id)).generation).toBe('0');
    expect((await identityFacts(other.id)).generation).toBe('0');
  });
});

describe('completeStaffCredentialSetup: the password is held to its bounds', () => {
  async function refused(password: unknown) {
    const row = await identity();
    const { token, id } = await grant(row.id);
    const response = await post(CREDENTIAL, { setup_token: token, password });
    const body = response.json() as { code: string; details?: { violations?: unknown[] } };
    expect(response.status).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(response.text).not.toContain(token);
    if (typeof password === 'string' && password.length > 0) {
      expect(response.text).not.toContain(password);
    }
    // The grant is not consumed and no credential exists.
    expect(await grantState(id)).toBe('PENDING');
    expect((await identityFacts(row.id)).generation).toBe('0');
    return body;
  }

  // Break caught: a bound counted in UTF-16 units or on the text as sent only; a refusal that echoes the value or consumes the grant.
  it.each([
    ['11 code points', 'a'.repeat(11)],
    ['129 code points', 'a'.repeat(129)],
    ['four U+FB03 ligatures: 4 as sent, 12 after NFKC', '\uFB03'.repeat(4)],
    ['a number', 123_456_789_012],
    ['nothing', undefined],
  ])(
    'refuses %s with VALIDATION_FAILED, not echoing it and not consuming the grant',
    async (_name, password) => {
      await refused(password);
    },
  );

  it('refuses a value of 12 code points as sent that normalises below 12, naming the field and not the value', async () => {
    const body = await refused('e\u0301'.repeat(6));
    expect(body.details?.violations).toEqual([
      { in: 'body', pointer: '/password', rule: 'minLength' },
    ]);
  });

  // Break caught: the password judged after the grant, so that a refusal of the password depends on whether the token is real (the
  // answer would tell a caller whether a token resolves, which no refusal of a grant is allowed to do).
  it('judges the password before the grant: the same 400 for a token that is real and for one that is not', async () => {
    const answer = await post(CREDENTIAL, {
      setup_token: tokens.issue().token,
      password: 'é'.repeat(6),
    });

    expect(answer.status).toBe(400);
    expect((answer.json() as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('refuses a lone surrogate without echoing it', async () => {
    await refused(`${'a'.repeat(11)}\uD800`);
  });

  it('refuses a body with a missing token, an extra member or a token that is not text', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id);

    for (const body of [
      { password: PASSWORD },
      { setup_token: 42, password: PASSWORD },
      { setup_token: token, password: PASSWORD, bundle: BUNDLE_IDS.platformAdmin },
      { setup_token: token, password: PASSWORD, status: 'ACTIVE' },
    ]) {
      const response = await post(CREDENTIAL, body);
      expect(response.status).toBe(400);
      expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
    }
    expect(await grantState(id)).toBe('PENDING');
  });
});

describe('completeStaffCredentialSetup: it is a browser pre-session mutation', () => {
  // Break caught: an Origin check applied after the token was examined, or one that lets a foreign page, a page of the other
  // surface, or no Origin at all through; each would let a page the employee did not open consume the grant.
  it.each([
    ['no Origin', null],
    ['a foreign Origin', 'https://evil.example'],
    ['the Origin of the Vendor PWA', 'http://127.0.0.1:5174'],
    ['the literal null', 'null'],
  ])(
    'refuses %s with 403 CSRF_VALIDATION_FAILED before the grant is examined',
    async (_name, origin) => {
      const row = await identity();
      const { token, id } = await grant(row.id);

      const response = await post(
        CREDENTIAL,
        { setup_token: token, password: PASSWORD },
        { origin },
      );

      expect(response.status).toBe(403);
      expect((response.json() as { code: string }).code).toBe('CSRF_VALIDATION_FAILED');
      expect(await grantState(id)).toBe('PENDING');
      expect((await identityFacts(row.id)).generation).toBe('0');
    },
  );

  it('needs no session and no CSRF token: there is no session to hold one', async () => {
    const row = await identity();
    const { token } = await grant(row.id);

    const response = await post(
      CREDENTIAL,
      { setup_token: token, password: PASSWORD },
      { csrf: 'omit' },
    );

    expect(response.status).toBe(200);
  });
});

describe('completeStaffCredentialSetup: two completions of one grant have one winner', () => {
  // Break caught (AC-88): a read-then-write consumption, so that two requests carrying one grant both set a password, or the loser's
  // password is the one that is stored.
  it('lets exactly one of two concurrent requests win, refuses a third, and the winner’s password verifies', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id);
    const first = 'the first password wins';
    const second = 'the second password loses';

    const [a, b] = await Promise.all([
      post(CREDENTIAL, { setup_token: token, password: first }),
      post(CREDENTIAL, { setup_token: token, password: second }),
    ]);
    const third = await post(CREDENTIAL, {
      setup_token: token,
      password: 'a third password, after',
    });

    const statuses = [a.status, b.status].toSorted();
    expect(statuses).toEqual([200, 422]);
    expect(third.status).toBe(422);
    expect((third.json() as { code: string }).code).toBe('SETUP_GRANT_INVALID');
    const winner = a.status === 200 ? first : second;
    const loser = a.status === 200 ? second : first;
    const { hash, generation } = await identityFacts(row.id);
    expect(generation).toBe('1');
    expect((await hasher.verify('STAFF_PASSWORD', winner, hash ?? '')).matches).toBe(true);
    expect((await hasher.verify('STAFF_PASSWORD', loser, hash ?? '')).matches).toBe(false);
    expect(await grantState(id)).toBe('CONSUMED');
    expect(
      codesOf(await auditAbout(row.id)).filter((code) => code === 'auth.credential.changed'),
    ).toHaveLength(1);
  });
});

describe('the limits in front of the operations', () => {
  // Break caught (AC-125): a key that is the token itself (stored in clear), is not qualified by the operation (a value presented
  // to one operation counts against another's), or is taken only when the token resolves (an invented token buys a fresh key).
  it('counts each presented token under a key of its own, a made-up one included, and refuses the eleventh in a minute', async () => {
    const token = tokens.issue().token;
    const other = tokens.issue().token;

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await post(CREDENTIAL, { setup_token: token, password: PASSWORD })).status).toBe(422);
    }
    const refused = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });

    expect(refused.status).toBe(429);
    expect((refused.json() as { code: string }).code).toBe('RATE_LIMITED');
    expect(refused.header('retry-after')).toBeNull();
    // Another token has a key of its own, and the same token at another operation counts there, under its own purpose.
    expect((await post(CREDENTIAL, { setup_token: other, password: PASSWORD })).status).toBe(422);
    expect((await post(MFA, { setup_token: token, totp_code: '123456' })).status).toBe(422);
    expect((await post(BEGIN, { setup_token: token })).status).toBe(422);
    // The limiter stores a pseudonym, never the token.
    const stored = await kit.observe.rows<{ n: number }>(
      `select count(*)::int as n from rate_limit_admission where position(convert_to($1::text, 'UTF8') in key_digest) > 0`,
      [token],
    );
    expect(stored[0]?.n ?? 0).toBe(0);
  });

  // Break caught: hashing before the grant is judged (an unknown token would cost a hash, so a caller could exhaust the slots with
  // invented tokens), or a full set of slots turned into a refusal of a request that needs no hash.
  it('answers an unknown token without a hash when every slot is taken, and a valid one RATE_LIMITED without consuming it', async () => {
    const admission = kit.app.app.get<HashAdmission>(HASH_ADMISSION, { strict: false });
    const row = await identity();
    const { token, id } = await grant(row.id);
    const held: HashSlot[] = [];
    for (let slot = admission.tryAdmit(); slot !== null; slot = admission.tryAdmit())
      held.push(slot);
    try {
      const unknown = await post(CREDENTIAL, {
        setup_token: tokens.issue().token,
        password: PASSWORD,
      });
      const valid = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });
      // A grant for an identity that already holds a credential, and one for a suspended identity, cost no hash either.
      const credentialed = await identity({
        credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
        credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
      });
      const suspended = await identity({ status: 'SUSPENDED' });
      const credentialedAnswer = await post(CREDENTIAL, {
        setup_token: (await grant(credentialed.id)).token,
        password: PASSWORD,
      });
      const suspendedAnswer = await post(CREDENTIAL, {
        setup_token: (await grant(suspended.id)).token,
        password: PASSWORD,
      });

      expect(unknown.status).toBe(422);
      expect(credentialedAnswer.status).toBe(422);
      expect(suspendedAnswer.status).toBe(422);
      expect(valid.status).toBe(429);
      expect((valid.json() as { code: string }).code).toBe('RATE_LIMITED');
      expect(await grantState(id)).toBe('PENDING');
      expect((await identityFacts(row.id)).generation).toBe('0');
    } finally {
      for (const slot of held) slot.release();
    }
    // The slots are back, and the same grant now works.
    expect((await post(CREDENTIAL, { setup_token: token, password: PASSWORD })).status).toBe(200);
  });
});

describe('completeStaffCredentialSetup: a privileged identity', () => {
  // Break caught: a privileged identity made authentication-ready by the password alone (the whole of MFA skipped), a seed returned
  // that is not the one sealed, or a continuation grant that is not tied to the grant that produced it.
  it('establishes the password and answers with the provisioning material and a continuation grant, and no session', async () => {
    const row = await privileged();
    const { token, id } = await grant(row.id);

    const response = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.header('set-cookie')).toBeNull();
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual([
      'authentication_ready',
      'mfa_enrolment_required',
      'mfa_provisioning',
      'mfa_setup_token',
    ]);
    expect(body).toMatchObject({ authentication_ready: false, mfa_enrolment_required: true });
    const provisioned = provisioningOf(response);
    const uri = new URL(provisioned.uri);
    expect(uri.protocol).toBe('otpauth:');
    expect(decodeURIComponent(uri.pathname.slice(1))).toBe(`Melarc:${row.workEmail}`);
    expect(provisioned.seed).toHaveLength(20);
    expect(provisioned.mfaToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(provisioned.mfaToken).not.toBe(token);

    expect((await identityFacts(row.id)).generation).toBe('1');
    expect(await sessionsOf(row.id)).toBe(0);
    const factors = await factorsOf(row.id);
    expect(factors).toHaveLength(1);
    expect(factors[0]).toMatchObject({
      status: 'PENDING',
      created_by_purpose: 'STAFF_CREDENTIAL_SETUP',
      created_episode_id: null,
      enrolled_at: null,
      last_verified_counter: null,
    });
    // The seed is sealed: the stored bytes are not the seed, and the seed is in no other column of the row.
    expect(factors[0]?.secret_ciphertext.includes(Buffer.from(provisioned.seed))).toBe(false);
    const grants = await grantsOf(row.id);
    const continuation = grants.find((each) => each.purpose === 'MFA_ENROLMENT');
    expect(continuation).toMatchObject({
      state: 'PENDING',
      continued_from_grant_id: id,
      episode_id: null,
    });
    expect(grants.find((each) => each.id === id)?.state).toBe('CONSUMED');
    // The continuation lives for the ordinary security-link interval, 30 minutes, on the database's clock.
    const minutes =
      ((continuation?.expires_at?.getTime() ?? 0) - (continuation?.issued_at.getTime() ?? 0)) /
      60_000;
    expect(minutes).toBe(30);
  });

  it('writes the events of the act, the continuation’s issue among them, and nothing that is a secret', async () => {
    const proof = await awaitingProof();

    const events = await auditAbout(proof.row.id);

    expect(codesOf(events)).toEqual([
      'auth.credential.changed',
      'auth.setup_grant.consumed',
      'auth.setup_grant.issued',
    ]);
    const issued = eventOf(events, 'auth.setup_grant.issued');
    expect(issued.detail).toMatchObject({
      purpose: 'MFA_ENROLMENT',
      channel: 'RESPONSE',
      principal_type: 'STAFF',
    });
    const everything = JSON.stringify(events);
    for (const secret of [
      PASSWORD,
      proof.mfaToken,
      proof.uri,
      Buffer.from(proof.seed).toString('hex'),
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(kit.app.logs.text()).not.toContain(proof.mfaToken);
    expect(kit.app.logs.text()).not.toContain(new URL(proof.uri).searchParams.get('secret') ?? 'x');
  });

  // Break caught: the grant consumed, the credential written or the factor created in separate transactions: a failure in the last
  // would leave a password set, a grant spent and no way to enrol (the employee locked out of their own onboarding).
  it('does all of it or none of it: a failure creating the factor leaves the grant open and no credential', async () => {
    const row = await privileged();
    const { token, id } = await grant(row.id);
    const broken = await kit.admin.breakWrites('mfa_factor');
    try {
      const response = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await broken.mend();
    }

    expect(await grantState(id)).toBe('PENDING');
    expect((await identityFacts(row.id)).generation).toBe('0');
    expect(await factorsOf(row.id)).toEqual([]);
    expect((await grantsOf(row.id)).map((each) => each.purpose)).toEqual([
      'STAFF_CREDENTIAL_SETUP',
    ]);
    expect(codesOf(await auditAbout(row.id))).toEqual([]);
    // Mended, the same grant completes.
    expect((await post(CREDENTIAL, { setup_token: token, password: PASSWORD })).status).toBe(200);
  });

  // Break caught: an identity that ends the setup with two PENDING factors (an earlier provisioning that was never proven, and the
  // new one), either of which a continuation could then be proved against.
  it('revokes an earlier PENDING factor, with an event for it, so that one is PENDING', async () => {
    const row = await privileged();
    const stale = randomUUID();
    await kit.admin.query(
      `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                               secret_envelope_version, created_by_purpose)
       values ($1, $2, 'TOTP', 'PENDING', $3, $4, 1, 1, 'STAFF_CREDENTIAL_SETUP')`,
      [stale, row.id, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
    );
    const { token } = await grant(row.id);

    expect((await post(CREDENTIAL, { setup_token: token, password: PASSWORD })).status).toBe(200);

    const factors = await factorsOf(row.id);
    expect(factors.map((factor) => factor.status).toSorted()).toEqual(['PENDING', 'REVOKED']);
    expect(factors.find((factor) => factor.id === stale)?.status).toBe('REVOKED');
    expect(codesOf(await auditAbout(row.id))).toContain('auth.mfa.revoked');
  });

  it('judges the identity under its lock: one suspended while the request waited gets no credential', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id);

    const response = await raceAgainstChange(row.id, SUSPEND, () =>
      post(CREDENTIAL, { setup_token: token, password: PASSWORD }),
    );

    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect((await identityFacts(row.id)).generation).toBe('0');
    expect(await grantState(id)).toBe('PENDING');
  });

  // Break caught (AC-88, the lock order of SECURITY_DESIGN.md §13.10a): a decision about the identity made on a read that takes no
  // lock, so that a credential could be written for an identity that another transaction is changing at that moment.
  it('waits for the identity lock another transaction holds, and completes when it is released', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id);
    const holder = clientFor(database.urlFor('postgres'));
    const observer = clientFor(database.urlFor('postgres'));
    await holder.connect();
    await observer.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from staff_identity where id = $1 for no key update', [row.id]);
      let finished = false;
      const request = post(CREDENTIAL, { setup_token: token, password: PASSWORD }).then(
        (response) => {
          finished = true;
          return response;
        },
      );
      // Seen waiting for the lock, which is what "waits for the identity lock" says; nothing is slept.
      await waitUntilBlockedBy(observer, await backendPidOf(holder), 'the request', request);

      expect(finished).toBe(false);
      expect(await grantState(id)).toBe('PENDING');

      await holder.query('commit');
      expect((await request).status).toBe(200);
    } finally {
      await holder.end();
      await observer.end();
    }
    expect((await identityFacts(row.id)).generation).toBe('1');
  });
});

describe('completeMfaEnrolment', () => {
  // Break caught: a factor activated without a proven code, a session issued, or the grant left open after the proof.
  it('activates the factor on a proven code, consumes the continuation and issues no session', async () => {
    const proof = await awaitingProof();

    const response = await post(MFA, {
      setup_token: proof.mfaToken,
      totp_code: codeFor(proof.seed),
    });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ authentication_ready: true });
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.header('set-cookie')).toBeNull();
    const [factor] = await factorsOf(proof.row.id);
    const step = String(Math.floor(kit.clock.now().getTime() / 30_000));
    expect(factor).toMatchObject({ status: 'ACTIVE', last_verified_counter: step });
    expect(factor?.enrolled_at).toBeInstanceOf(Date);
    const continuation = (await grantsOf(proof.row.id)).find(
      (each) => each.purpose === 'MFA_ENROLMENT',
    );
    expect(continuation?.state).toBe('CONSUMED');
    expect(await sessionsOf(proof.row.id)).toBe(0);
    const events = await auditAbout(proof.row.id);
    expect(codesOf(events)).toEqual([
      'auth.credential.changed',
      'auth.mfa.enrolled',
      'auth.setup_grant.consumed',
      'auth.setup_grant.consumed',
      'auth.setup_grant.issued',
    ]);
    const enrolled = eventOf(events, 'auth.mfa.enrolled');
    expect(enrolled).toMatchObject({
      enhanced: true,
      outcome: 'SUCCEEDED',
      object_type: 'MfaFactor',
      actor_type: 'STAFF',
      actor_id: proof.row.id,
    });
    expect(enrolled.before_after).not.toBeNull();
    // An identity made by maker and checker has no bootstrap to complete.
    expect(codesOf(events)).not.toContain('auth.bootstrap.completed');
  });

  // Break caught (AC-94): a wrong code that consumes the grant (the person is locked out by a typo) or activates the factor.
  it('leaves the factor PENDING and the grant open on a wrong code, and a right code on the same grant then succeeds', async () => {
    const proof = await awaitingProof();

    const wrong = await post(MFA, {
      setup_token: proof.mfaToken,
      totp_code: wrongCode(proof.seed),
    });

    expect(wrong.status).toBe(422);
    expect((wrong.json() as { code: string }).code).toBe('MFA_PROOF_INVALID');
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('PENDING');
    expect(
      (await grantsOf(proof.row.id)).find((each) => each.purpose === 'MFA_ENROLMENT')?.state,
    ).toBe('PENDING');
    expect(codesOf(await auditAbout(proof.row.id))).toHaveLength(3);

    const right = await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) });
    expect(right.status).toBe(200);
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('ACTIVE');
  });

  it('accepts the code of the step before and the step after, within the window of one step', async () => {
    const before = await awaitingProof();
    const after = await awaitingProof();

    expect(
      (await post(MFA, { setup_token: before.mfaToken, totp_code: codeFor(before.seed, -1) }))
        .status,
    ).toBe(200);
    expect(
      (await post(MFA, { setup_token: after.mfaToken, totp_code: codeFor(after.seed, 1) })).status,
    ).toBe(200);
  });

  it('refuses a code that is not six digits at the schema, and a grant that is spent with SETUP_GRANT_INVALID', async () => {
    const proof = await awaitingProof();

    for (const totp_code of ['12345', '1234567', '12345a', ' 123456', 123_456]) {
      const response = await post(MFA, { setup_token: proof.mfaToken, totp_code });
      expect(response.status).toBe(400);
      expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
    }
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('PENDING');
    expect(
      (await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) })).status,
    ).toBe(200);
    const again = await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) });
    expect(again.status).toBe(422);
    expect(again.json()).toMatchObject(SETUP_GRANT_INVALID);
  });

  // Break caught: any grant but the continuation activating a factor: the bootstrap secret above all, which has no expiry and so
  // would be a standing key to privileged access (AC-92). Each is presented with the **correct code of a factor that is PENDING** for
  // the same identity, so the only thing that can refuse it is its purpose.
  it('refuses a grant of any other purpose, the bootstrap secret among them, even with the right code and a factor to prove', async () => {
    const proof = await awaitingProof();
    const others = [
      await grant(proof.row.id, 'BOOTSTRAP_SETUP'),
      await grant(proof.row.id, 'STAFF_CREDENTIAL_SETUP'),
      await grant(proof.row.id, 'MFA_REENROLMENT', { episodeId: randomUUID() }),
    ];

    for (const { token } of others) {
      const response = await post(MFA, { setup_token: token, totp_code: codeFor(proof.seed) });
      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
      // And with a wrong code the answer is the same: `MFA_PROOF_INVALID` for a grant that is not the enrolment's would tell the
      // caller that the token is a real grant of this identity.
      const wrong = await post(MFA, { setup_token: token, totp_code: wrongCode(proof.seed) });
      expect(wrong.status).toBe(422);
      expect(wrong.json()).toMatchObject(SETUP_GRANT_INVALID);
    }

    for (const { id } of others) expect(await grantState(id)).toBe('PENDING');
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('PENDING');
    // The continuation itself still proves it.
    expect(
      (await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) })).status,
    ).toBe(200);
  });

  // Break caught: the oldest PENDING factor proved instead of the newest, so that a code from the authenticator just provisioned is
  // judged against an abandoned seed (or the abandoned one is activated). The two are told apart by the place the database allocated
  // (F01 of the audit of 22 October 2026), and here the identifiers say the opposite: the abandoned factor has the GREATER one. The service
  // ends every stale PENDING factor when it provisions a new one, so two live PENDING factors can only be arranged by the administrator,
  // who sets the places directly with the table's user triggers set aside for those two statements and set back at once. The abandoned
  // factor's sealed secret is one that cannot be opened, so proving it instead of the newest fails.
  it('proves the newest PENDING factor when an older one was never proven', async () => {
    const proof = await awaitingProof();
    const abandoned = 'ffffffff-ffff-7fff-bfff-000000000001';
    await admin.query('alter table mfa_factor disable trigger user');
    try {
      await admin.query('update mfa_factor set ordinal = 2 where staff_identity_id = $1', [
        proof.row.id,
      ]);
      await admin.query(
        `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                                 secret_envelope_version, created_by_purpose, ordinal)
         values ($1, $2, 'TOTP', 'PENDING', $3, $4, 1, 1, 'STAFF_CREDENTIAL_SETUP', 1)`,
        [abandoned, proof.row.id, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
      );
    } finally {
      await admin.query('alter table mfa_factor enable trigger user');
    }

    const response = await post(MFA, {
      setup_token: proof.mfaToken,
      totp_code: codeFor(proof.seed),
    });

    expect(response.status).toBe(200);
    const factors = await factorsOf(proof.row.id);
    expect(factors.filter((factor) => factor.status === 'ACTIVE')).toHaveLength(1);
    expect(factors.find((factor) => factor.status === 'ACTIVE')?.id).not.toBe(abandoned);
  });

  // Break caught (audit.md §5.4: "A factor was revoked, by reset or by replacement. Enhanced"): a factor that stops being ACTIVE
  // because another was proven, with no event to say so.
  it('revokes the ACTIVE factor a proven re-enrolment replaces, with an enhanced event for it', async () => {
    const proof = await awaitingProof();
    expect(
      (await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) })).status,
    ).toBe(200);
    const [first] = await factorsOf(proof.row.id);
    const reset = await grant(proof.row.id, 'MFA_REENROLMENT', { episodeId: randomUUID() });
    const begun = await post(BEGIN, { setup_token: reset.token });
    expect(begun.status).toBe(200);
    const second = provisioningOf(begun);

    expect(
      (await post(MFA, { setup_token: second.mfaToken, totp_code: codeFor(second.seed) })).status,
    ).toBe(200);

    const factors = await factorsOf(proof.row.id);
    expect(factors.map((factor) => factor.status).toSorted()).toEqual(['ACTIVE', 'REVOKED']);
    expect(factors.find((factor) => factor.id === first?.id)?.status).toBe('REVOKED');
    const replaced = (await auditAbout(proof.row.id)).find(
      (event) => event.event_code === 'auth.mfa.revoked' && event.object_id === first?.id,
    );
    expect(replaced).toMatchObject({ enhanced: true, outcome: 'SUCCEEDED' });
    expect(replaced?.detail).toMatchObject({ cause: 'REPLACED' });
  });

  // Break caught (staff-authentication.md section 5.8, AC-SLICE-000-135): a trusted browser that survives the authenticator it vouched for
  // being replaced, or a replacement that ends it without a trace.
  it('ends the trusted browsers bound to the authenticator a proven re-enrolment replaces, with an event for each', async () => {
    const proof = await awaitingProof();
    expect(
      (await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) })).status,
    ).toBe(200);
    const [first] = await factorsOf(proof.row.id);
    const store = kit.app.app.get<TrustedBrowserStore>(TRUSTED_BROWSER_STORE, { strict: false });
    const unitOfWork = kit.app.app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
    const credential = tokens.issue();
    // The password was set by the operation just before, so the generation is the one it made.
    const generation = Number(
      (
        await kit.observe.one<{ generation: string }>(
          'select credential_generation::text as generation from staff_identity where id = $1',
          [proof.row.id],
        )
      )?.generation,
    );
    const remembered = await unitOfWork.run(systemContext('authentication'), (handle) =>
      store.issue(handle, {
        staffIdentityId: proof.row.id,
        tokenHash: credential.hash,
        factorId: first?.id ?? '',
        credentialGeneration: generation,
        label: 'Chrome on Windows',
      }),
    );
    const reset = await grant(proof.row.id, 'MFA_REENROLMENT', { episodeId: randomUUID() });
    const second = provisioningOf(await post(BEGIN, { setup_token: reset.token }));

    expect(
      (await post(MFA, { setup_token: second.mfaToken, totp_code: codeFor(second.seed) })).status,
    ).toBe(200);

    const browser = await kit.observe.one<{
      revocation_cause: string | null;
      revoked_by: string | null;
    }>('select revocation_cause, revoked_by from trusted_browser where id = $1', [
      remembered.browser.id,
    ]);
    expect(browser).toEqual({ revocation_cause: 'FACTOR_REPLACED', revoked_by: null });
    const ended = (await auditAbout(proof.row.id)).filter(
      (event) => event.event_code === 'auth.trusted_browser.revoked',
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      enhanced: false,
      outcome: 'SUCCEEDED',
      actor_type: 'STAFF',
      actor_id: proof.row.id,
      detail: { cause: 'FACTOR_REPLACED' },
    });
  });

  // Break caught (the lock order of SECURITY_DESIGN.md §13.10a): a status judged on a read that took no lock, so an identity
  // suspended while the request waited still enrols a factor. The request's first look sees ACTIVE; the decision is the locked read's.
  it('judges the identity under its lock: one suspended while the request waited is refused', async () => {
    const proof = await awaitingProof();

    const response = await raceAgainstChange(proof.row.id, SUSPEND, () =>
      post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) }),
    );

    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('PENDING');
    expect(
      (await grantsOf(proof.row.id)).find((each) => each.purpose === 'MFA_ENROLMENT')?.state,
    ).toBe('PENDING');
  });

  it('refuses a continuation whose factor is gone, and an unknown token, with the same answer', async () => {
    const proof = await awaitingProof();
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = now() where staff_identity_id = $1`,
      [proof.row.id],
    );

    const gone = await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) });
    const unknown = await post(MFA, { setup_token: tokens.issue().token, totp_code: '123456' });

    for (const response of [gone, unknown]) {
      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    }
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('REVOKED');
  });

  // Break caught: an activation that is a read-then-write, so that two requests carrying one code both succeed and the proof is
  // recorded (and the event written) twice.
  it('lets exactly one of two concurrent proofs of one grant win, and records one enrolment', async () => {
    const proof = await awaitingProof();
    const code = codeFor(proof.seed);

    const responses = await Promise.all([
      post(MFA, { setup_token: proof.mfaToken, totp_code: code }),
      post(MFA, { setup_token: proof.mfaToken, totp_code: code }),
    ]);

    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 422]);
    expect(
      codesOf(await auditAbout(proof.row.id)).filter((code2) => code2 === 'auth.mfa.enrolled'),
    ).toHaveLength(1);
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('ACTIVE');
  });

  it('is refused for a foreign Origin, before the grant or the code is examined', async () => {
    const proof = await awaitingProof();

    const response = await post(
      MFA,
      { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) },
      { origin: 'https://evil.example' },
    );

    expect(response.status).toBe(403);
    expect((response.json() as { code: string }).code).toBe('CSRF_VALIDATION_FAILED');
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('PENDING');
  });
});

describe('beginMfaReenrolment', () => {
  /** A reset authorisation: a live `MFA_REENROLMENT` grant of an episode, for an identity that holds a password. */
  async function authorised(withStaleFactor: boolean) {
    const row = await privileged({
      credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
    });
    const episodeId = randomUUID();
    const issued = await grant(row.id, 'MFA_REENROLMENT', { episodeId });
    let staleFactorId: string | null = null;
    if (withStaleFactor) {
      // The unusable PENDING factor of an earlier provisioning that was never proven.
      const stale = await kit.admin.query<{ id: string }>(
        `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                                 secret_envelope_version, created_by_purpose)
         values ($1, $2, 'TOTP', 'PENDING', $3, $4, 1, 1, 'STAFF_CREDENTIAL_SETUP') returning id`,
        [randomUUID(), row.id, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
      );
      staleFactorId = stale[0]?.id ?? null;
    }
    return { row, episodeId, staleFactorId, ...issued };
  }

  // Break caught: a re-enrolment that activates a factor (a reset authorisation standing in for possession of the new authenticator),
  // or one that issues a continuation outside the episode of the reset it continues.
  it('consumes the authorisation, provisions a new PENDING factor in the episode and issues a continuation, with no session', async () => {
    const reset = await authorised(false);

    const response = await post(BEGIN, { setup_token: reset.token });

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.header('set-cookie')).toBeNull();
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(['mfa_provisioning', 'mfa_setup_token']);
    const provisioned = provisioningOf(response);
    expect(await grantState(reset.id)).toBe('CONSUMED');
    const factors = await factorsOf(reset.row.id);
    expect(factors).toHaveLength(1);
    expect(factors[0]).toMatchObject({
      status: 'PENDING',
      created_by_purpose: 'MFA_REENROLMENT',
      created_episode_id: reset.episodeId,
    });
    const continuation = (await grantsOf(reset.row.id)).find(
      (each) => each.purpose === 'MFA_ENROLMENT',
    );
    expect(continuation).toMatchObject({
      state: 'PENDING',
      continued_from_grant_id: reset.id,
      episode_id: reset.episodeId,
    });
    expect((await identityFacts(reset.row.id)).generation).toBe('1');
    expect(await sessionsOf(reset.row.id)).toBe(0);
    const events = await auditAbout(reset.row.id);
    expect(codesOf(events)).toEqual([
      'auth.mfa.reenrolment_begun',
      'auth.setup_grant.consumed',
      'auth.setup_grant.issued',
    ]);
    expect(eventOf(events, 'auth.mfa.reenrolment_begun')).toMatchObject({
      enhanced: true,
      object_type: 'MfaFactor',
    });
    expect(JSON.stringify(events)).not.toContain(provisioned.mfaToken);

    // The continuation with a proven code is what activates it.
    const proven = await post(MFA, {
      setup_token: provisioned.mfaToken,
      totp_code: codeFor(provisioned.seed),
    });
    expect(proven.status).toBe(200);
    expect((await factorsOf(reset.row.id))[0]?.status).toBe('ACTIVE');
  });

  it('revokes the unusable PENDING factor it supersedes, with an event for it, and no more than one is PENDING', async () => {
    const reset = await authorised(true);

    expect((await post(BEGIN, { setup_token: reset.token })).status).toBe(200);

    const factors = await factorsOf(reset.row.id);
    expect(factors.map((factor) => factor.status).toSorted()).toEqual(['PENDING', 'REVOKED']);
    expect(factors.find((factor) => factor.id === reset.staleFactorId)?.status).toBe('REVOKED');
    const events = await auditAbout(reset.row.id);
    const revoked = events.find((event) => event.event_code === 'auth.mfa.revoked');
    expect(revoked).toMatchObject({
      enhanced: true,
      object_id: reset.staleFactorId,
      outcome: 'SUCCEEDED',
    });
  });

  // Break caught: a continuation issued while the identity still holds a live one (a reset after a credential setup whose first code was
  // never proved) naming the live grant as a predecessor too, which the table refuses: the whole act, the consumption of the
  // authorisation included, rolled back, and the person told nothing but a server error.
  it('ends the live continuation the identity still held, and writes the event that names the grant that replaced it', async () => {
    const reset = await authorised(false);
    const live = await grant(reset.row.id, 'MFA_ENROLMENT');

    const response = await post(BEGIN, { setup_token: reset.token });

    expect(response.status).toBe(200);
    expect(await grantState(reset.id)).toBe('CONSUMED');
    expect(await grantState(live.id)).toBe('SUPERSEDED');
    const issued = (await grantsOf(reset.row.id)).find(
      (each) => each.purpose === 'MFA_ENROLMENT' && each.state === 'PENDING',
    );
    expect(issued).toMatchObject({
      continued_from_grant_id: reset.id,
      episode_id: reset.episodeId,
    });
    const events = await auditAbout(reset.row.id);
    expect(codesOf(events)).toEqual([
      'auth.mfa.reenrolment_begun',
      'auth.setup_grant.consumed',
      'auth.setup_grant.issued',
      'auth.setup_grant.superseded',
    ]);
    expect(eventOf(events, 'auth.setup_grant.superseded')).toMatchObject({
      object_id: live.id,
      related_ids: { superseded_by: issued?.id },
    });
  });

  it('judges the identity under its lock: one suspended while the request waited gets no factor', async () => {
    const reset = await authorised(false);

    const response = await raceAgainstChange(reset.row.id, SUSPEND, () =>
      post(BEGIN, { setup_token: reset.token }),
    );

    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect(await grantState(reset.id)).toBe('PENDING');
    expect(await factorsOf(reset.row.id)).toEqual([]);
  });

  // Break caught: an authorisation consumed by a read-then-write, so that two requests carrying it each provision a factor and issue a
  // continuation (two live authenticators for one reset).
  it('lets exactly one of two concurrent requests win, and leaves one PENDING factor and one continuation', async () => {
    const reset = await authorised(true);

    const responses = await Promise.all([
      post(BEGIN, { setup_token: reset.token }),
      post(BEGIN, { setup_token: reset.token }),
    ]);

    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 422]);
    const factors = await factorsOf(reset.row.id);
    expect(factors.filter((factor) => factor.status === 'PENDING')).toHaveLength(1);
    const continuations = (await grantsOf(reset.row.id)).filter(
      (each) => each.purpose === 'MFA_ENROLMENT',
    );
    expect(continuations).toHaveLength(1);
    expect(codesOf(await auditAbout(reset.row.id))).toContain('auth.mfa.reenrolment_begun');
    expect(
      codesOf(await auditAbout(reset.row.id)).filter(
        (code) => code === 'auth.mfa.reenrolment_begun',
      ),
    ).toHaveLength(1);
  });

  // Break caught (AC-93's boundary): a re-enrolment authorisation that can be redeemed twice, or one that any other grant can stand in for.
  it('refuses a second use, a grant of another purpose and an unknown token with SETUP_GRANT_INVALID', async () => {
    const reset = await authorised(false);
    const setup = await identity();
    const setupGrant = await grant(setup.id);
    expect((await post(BEGIN, { setup_token: reset.token })).status).toBe(200);

    for (const token of [reset.token, setupGrant.token, tokens.issue().token]) {
      const response = await post(BEGIN, { setup_token: token });
      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    }
    expect(await grantState(setupGrant.id)).toBe('PENDING');
  });

  it('refuses a body that is not exactly the token, and a foreign Origin', async () => {
    const reset = await authorised(false);

    for (const body of [
      {},
      { setup_token: reset.token, totp_code: '123456' },
      { setup_token: 7 },
    ]) {
      const response = await post(BEGIN, body);
      expect(response.status).toBe(400);
      expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
    }
    const foreign = await post(
      BEGIN,
      { setup_token: reset.token },
      { origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
    expect(await grantState(reset.id)).toBe('PENDING');
    expect(await factorsOf(reset.row.id)).toEqual([]);
  });

  it('refuses an identity that is no longer ACTIVE, and does not consume the authorisation', async () => {
    const reset = await authorised(false);
    await admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [
      reset.row.id,
    ]);

    const response = await post(BEGIN, { setup_token: reset.token });

    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect(await grantState(reset.id)).toBe('PENDING');
    expect(await factorsOf(reset.row.id)).toEqual([]);
  });
});

/**
 * A grant whose expiry has passed is still `PENDING`: nothing moves it until the next issue, so "the state is PENDING" is not "the
 * grant can be used". The expiry is judged on the database's clock **before** a password is derived and **after** the identity's lock
 * has been waited for, before a seed is opened or a code is verified (the audit of 21 October 2026, A02): a refusal is then
 * `SETUP_GRANT_INVALID` and never the business refusal of a proof that was judged against a grant that no longer existed.
 */
describe('a grant that has expired and is still PENDING', () => {
  const MINUTES_AGO = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

  /** Moves the expiry of a grant, as the administrator past the table's guard, and its issue back so that the table's checks hold. */
  async function setExpiry(id: string, expiresAtSql: string): Promise<void> {
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

  /** Runs `work` and counts the password derivations the application made meanwhile. */
  async function derivationsDuring<T>(
    work: () => Promise<T>,
  ): Promise<{ result: T; derivations: number }> {
    const live = kit.app.app.get<Hasher>(HASHER, { strict: false });
    const original = live.hash.bind(live);
    let derivations = 0;
    live.hash = (...args) => {
      derivations += 1;
      return original(...args);
    };
    try {
      return { result: await work(), derivations };
    } finally {
      live.hash = (...args) => original(...args);
    }
  }

  const continuationOf = async (identityId: string): Promise<string> => {
    const found = (await grantsOf(identityId)).find((each) => each.purpose === 'MFA_ENROLMENT');
    if (found === undefined) throw new Error('the identity holds no continuation');
    return found.id;
  };

  // Break caught: an expired grant passing the cheap look, so that a caller who holds one buys the work of Argon2id before the refusal.
  it('is refused by completeStaffCredentialSetup before any password is derived, and changes nothing', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id, 'STAFF_CREDENTIAL_SETUP', {
      issuedAt: MINUTES_AGO(60),
      expiresAt: MINUTES_AGO(30),
    });
    const events = (await auditAbout(row.id)).length;

    const { result, derivations } = await derivationsDuring(() =>
      post(CREDENTIAL, { setup_token: token, password: PASSWORD }),
    );

    expect(result.status).toBe(422);
    expect(result.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect(derivations).toBe(0);
    expect(await grantState(id)).toBe('PENDING');
    expect((await identityFacts(row.id)).generation).toBe('0');
    expect(await auditAbout(row.id)).toHaveLength(events);
  });

  // Break caught: the code verified before the grant is judged, so that an expired continuation answers a business refusal (the
  // person is told the code is wrong) for a proof that was never going to be accepted.
  it.each([
    ['a wrong code', (seed: Uint8Array) => wrongCode(seed)],
    ['a correct code', (seed: Uint8Array) => codeFor(seed)],
  ])(
    'is refused by completeMfaEnrolment with %s as SETUP_GRANT_INVALID, and nothing moves',
    async (_name, code) => {
      const proof = await awaitingProof();
      const continuation = await continuationOf(proof.row.id);
      await setExpiry(continuation, "clock_timestamp() - interval '1 minute'");
      const events = (await auditAbout(proof.row.id)).length;

      const response = await post(MFA, {
        setup_token: proof.mfaToken,
        totp_code: code(proof.seed),
      });

      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
      expect(await grantState(continuation)).toBe('PENDING');
      const [factor] = await factorsOf(proof.row.id);
      expect(factor).toMatchObject({ status: 'PENDING', last_verified_counter: null });
      expect(await auditAbout(proof.row.id)).toHaveLength(events);
    },
  );

  it('is refused by beginMfaReenrolment, which creates no factor and consumes nothing', async () => {
    const row = await privileged({
      credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
    });
    const { token, id } = await grant(row.id, 'MFA_REENROLMENT', {
      episodeId: randomUUID(),
      issuedAt: MINUTES_AGO(60),
      expiresAt: MINUTES_AGO(30),
    });

    const response = await post(BEGIN, { setup_token: token });

    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect(await grantState(id)).toBe('PENDING');
    expect(await factorsOf(row.id)).toEqual([]);
  });

  // Break caught: the grant judged once, before the wait for the identity's lock. It expires while the request waits for a row that
  // nobody has changed, and what it decides under the lock must be judged on the time after the wait: a wrong code is then not a
  // wrong code of a live grant.
  it('is refused when it expires while the request waits for the identity lock, before the code is verified', async () => {
    const proof = await awaitingProof();
    const continuation = await continuationOf(proof.row.id);
    await setExpiry(continuation, "clock_timestamp() + interval '2 seconds'");

    const response = await raceAgainstChange(
      proof.row.id,
      'select $1::uuid as unchanged',
      () => post(MFA, { setup_token: proof.mfaToken, totp_code: wrongCode(proof.seed) }),
      lapsesWhileWaiting(continuation),
    );

    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect(await grantState(continuation)).toBe('PENDING');
    expect((await factorsOf(proof.row.id))[0]?.status).toBe('PENDING');
  });

  it('is refused when it expires while the request waits for the identity lock, and no password was set', async () => {
    const row = await identity();
    const { token, id } = await grant(row.id);
    await setExpiry(id, "clock_timestamp() + interval '2 seconds'");

    const response = await raceAgainstChange(
      row.id,
      'select $1::uuid as unchanged',
      () => post(CREDENTIAL, { setup_token: token, password: PASSWORD }),
      lapsesWhileWaiting(id),
    );

    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
    expect(await grantState(id)).toBe('PENDING');
    expect((await identityFacts(row.id)).generation).toBe('0');
  });

  /**
   * The grant expires after every look the request takes and before the table's guard looks at the row it consumes (the audit of 21 October
   * 2026, A06): a trigger that sleeps in front of the guard makes it so, and counts the times it was reached, so that a test cannot pass
   * because the expiry came early and was refused by a look before it. The guard's refusal fails the statement and the transaction with it:
   * the act rolls back whole, and the answer is the one every refusal of a grant has.
   */
  describe('that expires between its check and its consumption', () => {
    const EXPIRES_IN = "clock_timestamp() + interval '2500 milliseconds'";
    const DELAY_SECONDS = 3.2;
    const rowsOf = async (statement: string): Promise<readonly unknown[]> =>
      (await admin.query<Record<string, unknown>>(statement)).rows;

    it('is refused by completeStaffCredentialSetup as SETUP_GRANT_INVALID, and the act rolls back whole', async () => {
      const row = await identity();
      const { token, id } = await grant(row.id);
      await setExpiry(id, EXPIRES_IN);
      const events = (await auditAbout(row.id)).length;
      const race = await delayConsumption(rowsOf, 'setup_grant', DELAY_SECONDS);
      let response: TestResponse;
      let hits: number;
      try {
        response = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });
        hits = await race.hits();
      } finally {
        await race.remove();
      }

      expect(hits).toBe(1);
      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
      expect(await grantState(id)).toBe('PENDING');
      const facts = await identityFacts(row.id);
      expect(facts).toMatchObject({ generation: '0', hash: null });
      expect(await auditAbout(row.id)).toHaveLength(events);
    });

    it('is refused by completeMfaEnrolment, with a correct code, as SETUP_GRANT_INVALID, and nothing moves', async () => {
      const proof = await awaitingProof();
      const continuation = await continuationOf(proof.row.id);
      await setExpiry(continuation, EXPIRES_IN);
      const events = (await auditAbout(proof.row.id)).length;
      const race = await delayConsumption(rowsOf, 'setup_grant', DELAY_SECONDS);
      let response: TestResponse;
      let hits: number;
      try {
        response = await post(MFA, {
          setup_token: proof.mfaToken,
          totp_code: codeFor(proof.seed),
        });
        hits = await race.hits();
      } finally {
        await race.remove();
      }

      expect(hits).toBe(1);
      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
      expect(await grantState(continuation)).toBe('PENDING');
      const [factor] = await factorsOf(proof.row.id);
      expect(factor).toMatchObject({ status: 'PENDING', last_verified_counter: null });
      expect(await auditAbout(proof.row.id)).toHaveLength(events);
    });

    it('is refused by beginMfaReenrolment as SETUP_GRANT_INVALID, which creates no factor', async () => {
      const row = await privileged({
        credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
        credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
      });
      const { token, id } = await grant(row.id, 'MFA_REENROLMENT', { episodeId: randomUUID() });
      await setExpiry(id, EXPIRES_IN);
      const race = await delayConsumption(rowsOf, 'setup_grant', DELAY_SECONDS);
      let response: TestResponse;
      let hits: number;
      try {
        response = await post(BEGIN, { setup_token: token });
        hits = await race.hits();
      } finally {
        await race.remove();
      }

      expect(hits).toBe(1);
      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject(SETUP_GRANT_INVALID);
      expect(await grantState(id)).toBe('PENDING');
      expect(await factorsOf(row.id)).toEqual([]);
    });

    // Break caught (the audit: "do not swallow generic SQLSTATE 23514"): every check violation of the table answered as an expired
    // link, which would turn a defect into an ordinary refusal that nobody looks at.
    it.each([
      ['states no reason', null],
      ['states a reason that is no expiry', 'reason=SOMETHING_ELSE'],
    ])('does not answer a refusal that %s as an expired grant', async (_name, detail) => {
      const row = await identity();
      const { token, id } = await grant(row.id);
      const race = await refuseConsumption(rowsOf, 'setup_grant', detail);
      let response: TestResponse;
      let hits: number;
      try {
        response = await post(CREDENTIAL, { setup_token: token, password: PASSWORD });
        hits = await race.hits();
      } finally {
        await race.remove();
      }

      expect(hits).toBe(1);
      expect(response.status).toBe(500);
      expect(response.json()).not.toMatchObject(SETUP_GRANT_INVALID);
      expect(await grantState(id)).toBe('PENDING');
      expect((await identityFacts(row.id)).generation).toBe('0');
    });
  });
});
