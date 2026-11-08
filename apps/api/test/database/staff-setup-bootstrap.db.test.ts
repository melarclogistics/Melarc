import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { hotp } from '../../src/platform/auth/crypto/hotp.js';
import { Sha256TokenService } from '../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import { decodeBase32 } from '../../src/test-support/base32.js';
import type { RequestOptions, TestResponse } from '../../src/test-support/test-client.js';
import { PostgresBootstrapDatabase } from '../../src/tools/bootstrap/bootstrap-database.js';
import { planResume, planSeed } from '../../src/tools/bootstrap/bootstrap-plan.js';
import { BootstrapRefusedError } from '../../src/tools/bootstrap/bootstrap-vocabulary.js';
import { grantRow, insertGrant } from './support/credentials.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.31 against the bootstrap of S0.30 (`AC-SLICE-000-92`, `-93`, `-120`): the pair of Platform Admins the seed makes are taken through
 * the real operations over HTTP, with the secrets the plan holds (which a custody bundle would hold on a real run) presented as the
 * custodian would present them. The seed and the resume run as the provisioning login through the same functions the commands call;
 * no custody file is made, and every value is a throwaway of a disposable database.
 */

const OPS = 'http://127.0.0.1:5173';
const CREDENTIAL = '/api/v1/auth/staff/setup/credential';
const MFA = '/api/v1/auth/staff/setup/mfa';
const BEGIN = '/api/v1/auth/staff/setup/mfa/begin';
const PASSWORD = 'a bootstrap passphrase of mine';

const tokens = new Sha256TokenService();
const clock = new SystemClock();

let database: TestDatabase;
let kit: IntegrationKit;
let admin: pg.Client;
let provisioning: BuiltService;
let kofi: Administrator;
let efua: Administrator;

interface Administrator {
  readonly id: string;
  readonly email: string;
  /** The raw `BOOTSTRAP_SETUP` secret the plan holds for the custody bundle. */
  readonly secret: string;
}

const post = (path: string, body: unknown, options: RequestOptions = {}): Promise<TestResponse> =>
  kit.client.post(path, body, { origin: OPS, ...options });

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  provisioning = buildService(database, { login: PROVISIONING_ROLE });
  kit = await startIntegrationKit(database, { poolMax: 4 });

  const correlationId = `bootstrap-it-${randomUUID()}`;
  const plan = planSeed(
    [
      { fullName: 'Kofi Boateng', workEmail: 'kofi.boateng@melarc.example' },
      { fullName: 'Efua Addo', workEmail: 'efua.addo@melarc.example' },
    ],
    { tokens, clock, correlationId },
  );
  await new PostgresBootstrapDatabase(provisioning.service).run(correlationId, (calls) =>
    calls.seed(plan.document),
  );
  const [first, second] = plan.administrators;
  if (first === undefined || second === undefined) throw new Error('the seed planned no pair');
  [kofi, efua] = [first, second].map((entry) => ({
    id: entry.id,
    email: entry.workEmailCanonical,
    secret: entry.secret,
  })) as [Administrator, Administrator];
});

afterAll(async () => {
  await kit.stop();
  await provisioning.close();
  await admin.end();
  await database.drop();
});

const grantState = async (secretHolder: string, purpose: string): Promise<string[]> =>
  (
    await kit.observe.rows<{ state: string }>(
      'select state from setup_grant where principal_id = $1 and purpose = $2 order by id',
      [secretHolder, purpose],
    )
  ).map((row) => row.state);

/** The statuses of an identity's factors, in alphabetical order: factors made in one millisecond are not ordered by their ids. */
const factorStates = async (id: string): Promise<string[]> =>
  (
    await kit.observe.rows<{ status: string }>(
      'select status from mfa_factor where staff_identity_id = $1 order by id',
      [id],
    )
  )
    .map((row) => row.status)
    .toSorted();

const eventsOf = async (code: string, id: string): Promise<{ enhanced: boolean }[]> =>
  kit.observe.rows<{ enhanced: boolean }>(
    `select enhanced from audit_event where event_code = $1 and (object_id = $2::uuid or related_ids ->> 'principal_id' = $2::text)`,
    [code, id],
  );

const sessions = (): Promise<number> => kit.observe.count('session');

function provisioned(response: TestResponse): { seed: Uint8Array; mfaToken: string } {
  const body = response.json() as {
    mfa_provisioning: { otpauth_uri: string };
    mfa_setup_token: string;
  };
  const secret = new URL(body.mfa_provisioning.otpauth_uri).searchParams.get('secret') ?? '';
  return { seed: decodeBase32(secret), mfaToken: body.mfa_setup_token };
}

const codeFor = (seed: Uint8Array): string =>
  hotp(seed, Math.floor(kit.clock.now().getTime() / 30_000), 6);

describe('AC-SLICE-000-92: the bootstrap secret is consumed when the password is set and can never start MFA enrolment', () => {
  it('walks one of the two administrators from the secret to an ACTIVE factor, with no session on the way', async () => {
    // The secret is not an MFA_ENROLMENT grant: refused, and not consumed.
    const early = await post(MFA, { setup_token: kofi.secret, totp_code: '123456' });
    expect(early.status).toBe(422);
    expect((early.json() as { code: string }).code).toBe('SETUP_GRANT_INVALID');
    expect(await grantState(kofi.id, 'BOOTSTRAP_SETUP')).toEqual(['PENDING']);
    expect(await factorStates(kofi.id)).toEqual([]);

    // The password is established, the secret is consumed and a PENDING factor is provisioned with its continuation.
    const setup = await post(CREDENTIAL, { setup_token: kofi.secret, password: PASSWORD });
    expect(setup.status).toBe(200);
    expect(setup.json()).toMatchObject({
      authentication_ready: false,
      mfa_enrolment_required: true,
    });
    expect(setup.header('set-cookie')).toBeNull();
    const proof = provisioned(setup);
    expect(await grantState(kofi.id, 'BOOTSTRAP_SETUP')).toEqual(['CONSUMED']);
    expect(await grantState(kofi.id, 'MFA_ENROLMENT')).toEqual(['PENDING']);
    expect(await factorStates(kofi.id)).toEqual(['PENDING']);
    const created = await kit.observe.one<{ created_by_purpose: string }>(
      'select created_by_purpose from mfa_factor where staff_identity_id = $1',
      [kofi.id],
    );
    expect(created?.created_by_purpose).toBe('BOOTSTRAP_SETUP');

    // A second use of the secret is refused, and so is the secret at the MFA step again.
    const again = await post(CREDENTIAL, {
      setup_token: kofi.secret,
      password: 'another passphrase',
    });
    expect(again.status).toBe(422);
    expect((again.json() as { code: string }).code).toBe('SETUP_GRANT_INVALID');
    expect((await post(MFA, { setup_token: kofi.secret, totp_code: '123456' })).status).toBe(422);
    expect(await eventsOf('auth.bootstrap.completed', kofi.id)).toEqual([]);

    // The continuation grant with a proven code makes the factor ACTIVE and the identity authentication-ready.
    const proven = await post(MFA, { setup_token: proof.mfaToken, totp_code: codeFor(proof.seed) });
    expect(proven.status).toBe(200);
    expect(proven.json()).toEqual({ authentication_ready: true });
    expect(await factorStates(kofi.id)).toEqual(['ACTIVE']);
    expect(await grantState(kofi.id, 'MFA_ENROLMENT')).toEqual(['CONSUMED']);

    // auth.bootstrap.completed is written once for this identity, as an enhanced record, and the other administrator is untouched.
    expect(await eventsOf('auth.bootstrap.completed', kofi.id)).toEqual([{ enhanced: true }]);
    expect(await eventsOf('auth.bootstrap.completed', efua.id)).toEqual([]);
    expect(await grantState(efua.id, 'BOOTSTRAP_SETUP')).toEqual(['PENDING']);
    expect(await sessions()).toBe(0);

    // Written once per bootstrap identity: a factor that is reset and proven again leaves an identity that has been proven before, so
    // the second proof records the enrolment and not a second completion of the bootstrap.
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = now() where staff_identity_id = $1 and status = 'ACTIVE'`,
      [kofi.id],
    );
    const reset = tokens.issue();
    await insertGrant(
      admin,
      grantRow({
        principalId: kofi.id,
        purpose: 'MFA_REENROLMENT',
        tokenHash: Buffer.from(reset.hash),
        episodeId: randomUUID(),
      }),
    );
    const begun = await post(BEGIN, { setup_token: reset.token });
    expect(begun.status).toBe(200);
    const second = provisioned(begun);
    const reproven = await post(MFA, {
      setup_token: second.mfaToken,
      totp_code: codeFor(second.seed),
    });
    expect(reproven.status).toBe(200);
    expect(await factorStates(kofi.id)).toEqual(['ACTIVE', 'REVOKED']);
    expect(await eventsOf('auth.mfa.enrolled', kofi.id)).toHaveLength(2);
    expect(await eventsOf('auth.bootstrap.completed', kofi.id)).toEqual([{ enhanced: true }]);
  });
});

/**
 * Lets a grant's lifetime pass: it is issued two hours ago and expired an hour ago. A grant keeps everything but its state, and a state
 * can leave PENDING for EXPIRED only after the expiry, so the arrangement is the cluster administrator's, with the table's own triggers
 * set aside for this one statement and set back at once (the same hands that age a row for any test of an expiry).
 */
async function lapse(grantId: string): Promise<void> {
  await admin.query('alter table setup_grant disable trigger user');
  try {
    await admin.query(
      `update setup_grant set issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`,
      [grantId],
    );
  } finally {
    await admin.query('alter table setup_grant enable trigger user');
  }
}

describe('AC-SLICE-000-93 and -120: an expired continuation is recovered by the provisioning command and by nothing else', () => {
  async function resumeFor(administrator: Administrator) {
    const correlationId = `bootstrap-resume-${randomUUID()}`;
    return new PostgresBootstrapDatabase(provisioning.service).run(correlationId, async (calls) => {
      const { state } = await calls.identityState(administrator.email);
      const plan = planResume(state, { tokens, clock, correlationId });
      const outcome = await calls.resume(plan.document);
      return { plan, outcome };
    });
  }

  it('lets a stranded administrator re-enrol with the resume secret, and then refuses the resume for them', async () => {
    // Efua sets a password and her continuation grant lapses with the factor still PENDING.
    const setup = await post(CREDENTIAL, { setup_token: efua.secret, password: PASSWORD });
    expect(setup.status).toBe(200);
    const stranded = provisioned(setup);
    const [continuation] = (
      await kit.observe.rows<{ id: string }>(
        `select id from setup_grant where principal_id = $1 and purpose = 'MFA_ENROLMENT'`,
        [efua.id],
      )
    ).map((row) => row.id);
    await lapse(continuation ?? '');
    const lapsed = await post(MFA, {
      setup_token: stranded.mfaToken,
      totp_code: codeFor(stranded.seed),
    });
    expect(lapsed.status).toBe(422);
    expect(await factorStates(efua.id)).toEqual(['PENDING']);

    // The provisioning command issues a fresh MFA_REENROLMENT, which no API operation can do.
    const { plan, outcome } = await resumeFor(efua);
    expect(outcome.path).toBe('REENROLMENT');
    expect(await grantState(efua.id, 'MFA_REENROLMENT')).toEqual(['PENDING']);
    // The secret it made is not the bootstrap secret, which is not resurrected.
    expect(plan.secret).not.toBe(efua.secret);
    expect(await grantState(efua.id, 'BOOTSTRAP_SETUP')).toEqual(['CONSUMED']);
    const revived = await post(CREDENTIAL, {
      setup_token: efua.secret,
      password: 'a fresh passphrase here',
    });
    expect(revived.status).toBe(422);

    // beginMfaReenrolment consumes it, supersedes the unusable factor and issues a new continuation grant: no session, no new password.
    const begun = await post(BEGIN, { setup_token: plan.secret });
    expect(begun.status).toBe(200);
    expect(Object.keys(begun.json() as object).toSorted()).toEqual([
      'mfa_provisioning',
      'mfa_setup_token',
    ]);
    const fresh = provisioned(begun);
    expect(await factorStates(efua.id)).toEqual(['PENDING', 'REVOKED']);
    expect(await grantState(efua.id, 'MFA_REENROLMENT')).toEqual(['CONSUMED']);
    expect(await sessions()).toBe(0);
    const credential = await kit.observe.one<{ generation: string }>(
      'select credential_generation as generation from staff_identity where id = $1',
      [efua.id],
    );
    expect(credential?.generation).toBe('1');

    // The new continuation, with a proven code, activates the factor; the bootstrap is completed once, at this first proof.
    const proven = await post(MFA, { setup_token: fresh.mfaToken, totp_code: codeFor(fresh.seed) });
    expect(proven.status).toBe(200);
    expect(await factorStates(efua.id)).toEqual(['ACTIVE', 'REVOKED']);
    expect(await eventsOf('auth.bootstrap.completed', efua.id)).toEqual([{ enhanced: true }]);

    // Once the identity holds an ACTIVE factor the command refuses for it (AC-SLICE-000-120).
    await expect(resumeFor(efua)).rejects.toBeInstanceOf(BootstrapRefusedError);
    await expect(resumeFor(efua)).rejects.toMatchObject({ reason: 'ACTIVE_FACTOR' });
    expect(await sessions()).toBe(0);
  });
});
