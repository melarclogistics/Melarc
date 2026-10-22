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
import { planSeed } from '../../src/tools/bootstrap/bootstrap-plan.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The bootstrap journey to the first staff reads, over HTTP and a real PostgreSQL (the audit of 22 October 2026, "realistic bootstrap
 * journey"). A seeded Platform Admin has **no primary hub**: the seed makes the pair without one. So whatever the catalogue says of
 * "P: all hubs" is the whole of what such an administrator can reach, and a Platform Admin whose reach for the staff identity's keys
 * were its own hub would read, create and approve nobody. Nothing here is arranged: the seed is the real seed (`planSeed` through the
 * provisioning login), the password and the second factor are set by the real setup routes with the secret the plan holds, the session
 * is issued by the real sign-in and the code of a second step, and the reads are the real reads. The creation and the approval of an
 * identity are S0.36 and are not asserted here.
 */
const OPS = 'http://127.0.0.1:5173';
const CREDENTIAL = '/api/v1/auth/staff/setup/credential';
const MFA_SETUP = '/api/v1/auth/staff/setup/mfa';
const SIGN_IN = '/api/v1/auth/staff/sign-in';
const SIGN_IN_MFA = '/api/v1/auth/staff/sign-in/mfa';
const LIST = '/api/v1/staff-identities';
const ONE = (id: string) => `${LIST}/${id}`;
const PASSWORD = 'a bootstrap passphrase of mine';
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';

const tokens = new Sha256TokenService();
const clock = new SystemClock();

let database: TestDatabase;
let kit: IntegrationKit;
let admin: pg.Client;
let provisioning: BuiltService;
let kofi: { readonly id: string; readonly email: string; readonly secret: string };
let sequence = 0;

const post = (path: string, body: unknown, options: RequestOptions = {}): Promise<TestResponse> =>
  kit.client.post(path, body, { origin: OPS, ...options });

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  provisioning = buildService(database, { login: PROVISIONING_ROLE });
  kit = await startIntegrationKit(database, { poolMax: 4 });

  const correlationId = `bootstrap-journey-${randomUUID()}`;
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
  const first = plan.administrators[0];
  if (first === undefined) throw new Error('the seed planned no administrator');
  kofi = { id: first.id, email: first.workEmailCanonical, secret: first.secret };
});

afterAll(async () => {
  await kit.stop();
  await provisioning.close();
  await admin.end();
  await database.drop();
});

/** A target with a unique name, so that a list narrowed by `q` holds this test's identities and no other. */
async function target(tag: string, overrides: Partial<StaffRow>): Promise<StaffRow> {
  sequence += 1;
  return insertStaff(admin, staffRow({ fullName: `${tag} ${String(sequence)}`, ...overrides }));
}

describe('what the seed gives, and to whom', () => {
  // Break caught: the reach of the three identity keys left at `own` for Platform Admin (a catalogue that says "P: all hubs" and a seed
  // that does not), or widened for another holder.
  it('grants a Platform Admin staff.read, staff.identity.create and staff.identity.approve at all hubs, and others their own hub', async () => {
    const grants = await admin.query<{ bundle: string; permission_key: string; hub_scope: string }>(
      `select b.name as bundle, g.permission_key, g.hub_scope
         from role_bundle_grant g join role_bundle b on b.id = g.bundle_id
        where g.permission_key in ('staff.read', 'staff.identity.create', 'staff.identity.approve')
        order by b.name, g.permission_key`,
    );

    expect(grants.rows).toEqual([
      { bundle: 'Ops Staff', permission_key: 'staff.identity.create', hub_scope: 'own' },
      { bundle: 'Platform Admin', permission_key: 'staff.identity.approve', hub_scope: 'all' },
      { bundle: 'Platform Admin', permission_key: 'staff.identity.create', hub_scope: 'all' },
      { bundle: 'Platform Admin', permission_key: 'staff.read', hub_scope: 'all' },
      { bundle: 'Senior Ops', permission_key: 'staff.identity.approve', hub_scope: 'own' },
      { bundle: 'Senior Ops', permission_key: 'staff.identity.create', hub_scope: 'own' },
      { bundle: 'Senior Ops', permission_key: 'staff.read', hub_scope: 'own' },
    ]);
  });
});

describe('a seeded Platform Admin, from the bootstrap secret to the first reads of staff', () => {
  it('has no primary hub, sets its password and second factor, signs in with a code, and reads the staff of every hub', async () => {
    // The seed: a Platform Admin of the bootstrap origin with no primary hub.
    const seeded = await admin.query<{
      role_bundle_id: string;
      primary_hub_id: string | null;
      origin: string;
      status: string;
    }>('select role_bundle_id, primary_hub_id, origin, status from staff_identity where id = $1', [
      kofi.id,
    ]);
    expect(seeded.rows[0]).toEqual({
      role_bundle_id: BUNDLE_IDS.platformAdmin,
      primary_hub_id: null,
      origin: 'BOOTSTRAP',
      status: 'ACTIVE',
    });

    // The password, then the second factor, by the real routes and the secret the plan holds.
    const setup = await post(CREDENTIAL, { setup_token: kofi.secret, password: PASSWORD });
    expect(setup.status).toBe(200);
    const body = setup.json() as {
      mfa_provisioning: { otpauth_uri: string };
      mfa_setup_token: string;
    };
    const seed = decodeBase32(
      new URL(body.mfa_provisioning.otpauth_uri).searchParams.get('secret') ?? '',
    );
    const codeAt = (offsetSteps = 0): string =>
      hotp(seed, Math.floor(kit.clock.now().getTime() / 30_000) + offsetSteps, 6);
    const enrolled = await post(MFA_SETUP, {
      setup_token: body.mfa_setup_token,
      totp_code: codeAt(),
    });
    expect(enrolled.status).toBe(200);
    expect(enrolled.json()).toEqual({ authentication_ready: true });

    // The sign-in: the password, then a code of a later step than the one that proved the factor (a code is never used twice).
    kit.clock.advance(31_000);
    const first = await post(SIGN_IN, { email: kofi.email, password: PASSWORD });
    expect(first.status).toBe(202);
    const challenge = (first.json() as { challenge_id: string }).challenge_id;
    const signedIn = await post(SIGN_IN_MFA, { challenge_id: challenge, code: codeAt() });
    expect(signedIn.status).toBe(200);
    expect(signedIn.setCookies.map((cookie) => cookie.name).toSorted()).toEqual([
      'melarc_csrf',
      'melarc_session',
    ]);

    // The session the real sign-in issued: the seeded bundle's grants, with the all-hub scope, and no hub of its own.
    const session = await admin.query<{
      authorized_hub_ids: string[];
      bundle_snapshot: { grants: { permission: string; hubScope: string }[] };
    }>(
      `select authorized_hub_ids, bundle_snapshot from session where principal_id = $1 and terminated_at is null`,
      [kofi.id],
    );
    expect(session.rows).toHaveLength(1);
    expect(session.rows[0]?.authorized_hub_ids).toEqual([]);
    expect(
      session.rows[0]?.bundle_snapshot.grants
        .filter((grant) =>
          ['staff.read', 'staff.identity.create', 'staff.identity.approve'].includes(
            grant.permission,
          ),
        )
        .map((grant) => [grant.permission, grant.hubScope])
        .toSorted(),
    ).toEqual([
      ['staff.identity.approve', 'all'],
      ['staff.identity.create', 'all'],
      ['staff.read', 'all'],
    ]);

    // The reads: identities of two hubs and one with no hub, none of them this administrator's own hub (it has none).
    const tag = `Zq${randomUUID().slice(0, 8)}`;
    const inA = await target(tag, { primaryHubId: HUB_A });
    const inB = await target(tag, { primaryHubId: HUB_B });
    const hubless = await target(tag, { primaryHubId: null });

    const listed = await kit.client.get(`${LIST}?q=${tag}`);
    expect(listed.status).toBe(200);
    expect(listed.header('etag')).toBeNull();
    const page = listed.json() as { items: { id: string }[]; next_page_token: string | null };
    expect(page.items.map((item) => item.id).toSorted()).toEqual(
      [inA.id, inB.id, hubless.id].toSorted(),
    );
    expect(page.next_page_token).toBeNull();

    // One boundary event for each foreign hub the page represents (the administrator has no hub of its own, so both are foreign), and
    // none for the identity that has no hub.
    const crossings = async (): Promise<{ object_type: string; object_id: string | null }[]> =>
      (
        await admin.query<{ object_type: string; object_id: string | null }>(
          `select object_type, object_id from audit_event
            where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
          [kofi.id],
        )
      ).rows;
    expect((await crossings()).map((row) => [row.object_type, row.object_id]).toSorted()).toEqual(
      [
        ['HUB', HUB_A],
        ['HUB', HUB_B],
      ].toSorted(),
    );

    const one = await kit.client.get(ONE(inB.id));
    expect(one.status).toBe(200);
    expect(one.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect((await crossings()).at(-1)).toEqual({ object_type: 'StaffIdentity', object_id: inB.id });
    const before = (await crossings()).length;
    const flat = await kit.client.get(ONE(hubless.id));
    expect(flat.status).toBe(200);
    expect((await crossings()).length).toBe(before);
  });
});
