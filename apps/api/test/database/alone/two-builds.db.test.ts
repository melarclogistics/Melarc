// Runs alone: it compiles a second build of the API and starts two API processes on one database, each of which must be ready within 20 seconds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type pg from 'pg';

import { Argon2Hasher } from '../../../src/platform/auth/crypto/argon2.hasher.adapter.js';
import { Sha256TokenService } from '../../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import { normaliseNewCredential } from '../../../src/platform/auth/credentials/credential-rule.js';
import {
  changeFixedPolicy,
  changeRoleBundle,
  type PolicyChangeResult,
} from '../../../src/platform/authorization/policy-change/policy-change.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../../src/platform/config/load-config.js';
import { validEnv } from '../../../src/test-support/config-env.js';
import { TestClient, type TestResponse } from '../../../src/test-support/test-client.js';
import { MIGRATION_ROLE } from '../../../src/tools/database/safety.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import {
  DEADLINES,
  freePort,
  killAll,
  start,
  type RunningProcess,
} from '../../support/api-process.js';
import { buildRelease, RELEASE_2, RELEASE_2_REVISION } from '../../support/policy-release.js';
import { signChallenge } from '../support/rider-sign-in.js';
import { insertSessionRow, sessionRow } from '../support/identities.js';
import { insertRider, insertRiderDevice, riderRow } from '../support/riders.js';
import { seedReferenceData } from '../support/seeded.js';
import { clientFor, createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { insertDevice, insertVendor, vendorRow } from '../support/vendors.js';

/**
 * The fixed-policy rule run as it is deployed (S0.63; SECURITY_DESIGN.md section 13.10 and section 13.10a, obligation 13; the compiled-policy
 * clause of AC-SLICE-000-05; `GBT-C11` and `GBT-D12`): **two real
 * builds of the API** on one database, both as the runtime login. The current build is this tree, compiled revision 1 for the Vendor and the
 * Rider. The newer build is the same source compiled with the changes of a release (`test/support/policy-release.ts`): revision 2 for both,
 * a Rider ownership predicate that admits a Rider holding `settings.reason.read` to `listReasonDefinitions`, and the same operation served
 * to a Vendor whose snapshot holds that key. The database is told of the release the only way it can be, by the migration login through
 * `melarc.change_fixed_policy` (and, for the Vendor's new key, `melarc.change_role_bundle`), never by a direct write.
 *
 * The release is rolled out twice, each time on a fresh database: once declared an **addition**, which is honest (both changes widen),
 * leaving the floor at 1 so that the two builds serve side by side; and once declared a **reduction**, which is always allowed (a reduction
 * can only end more sessions), raising the floor to 2 so that the older build is below it. Sessions are issued by the real sign-ins of the
 * two builds, never written; the one exception is the session the reduction's scan "missed", which the lock protocol makes impossible to
 * produce and which is therefore arranged as a row, saying so.
 */

const VENDOR_ORIGIN = 'http://127.0.0.1:5174';
const API = '/api/v1';
const SESSION = `${API}/auth/session`;
const REASONS = `${API}/reason-definitions`;
const DEVICES = `${API}/auth/vendor/devices`;
const PIN = '739204';
const SECRET = 'the shared secret of the release';

const env = validEnv({ NODE_ENV: 'production', APP_ENV: 'local', DATABASE_POOL_MAX: '2' });
const config = (() => {
  const loaded = loadConfig(env);
  if (!loaded.ok) throw new Error('the configuration was refused');
  return loaded.config;
})();
// The same pepper and cost the two processes verify with, so an arranged secret and PIN are the ones a person set up.
const hasher = new Argon2Hasher(
  config.keys,
  config.credentialHashing.profile,
  config.credentialHashing.acceptedProfiles,
);
const tokens = new Sha256TokenService();

type Audience = 'VENDOR' | 'RIDER';

/** One running build: its process and its address. */
interface Build {
  readonly name: string;
  readonly running: RunningProcess;
  readonly baseUrl: string;
}

/** A live session as the client holds it, and the row it is. */
interface Held {
  readonly audience: Audience;
  readonly sessionId: string;
  /** The synchronizer token a browser session sends on an unsafe request (the Vendor PWA reads it from its cookie); none for a Rider. */
  readonly csrf?: string;
  /** A client presenting this session's credentials to `build`. */
  on(build: Build): TestClient;
}

/** A Vendor or a Rider who completed setup (the rows setup leaves), and the sign-in their client makes. */
interface Principal {
  readonly audience: Audience;
  readonly id: string;
  signIn(build: Build): Promise<{ readonly response: TestResponse; readonly held?: Held }>;
}

interface World {
  readonly database: TestDatabase;
  readonly admin: pg.Client;
  readonly migration: pg.Client;
  readonly current: Build;
  readonly newer: Build;
}

let currentMain = '';
let releaseMain = '';

// Both builds are compiled from this tree (or found already compiled for exactly this tree), each in a hook of its own: a cold
// compile of the API takes some 15 to 20 seconds.
beforeAll(() => {
  currentMain = buildRelease('current', []);
});
beforeAll(() => {
  releaseMain = buildRelease('release-2', RELEASE_2);
});
afterAll(killAll);

async function launch(name: string, script: string, database: TestDatabase): Promise<Build> {
  const port = await freePort();
  const running = start(script, {
    ...env,
    HTTP_PORT: String(port),
    DATABASE_URL: database.urlFor(API_RUNTIME_ROLE),
  });
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  await running.waitUntilReady(baseUrl);
  return { name, running, baseUrl };
}

const tokenHashOf = (token: string): Buffer => {
  const hash = tokens.hash(token);
  if (hash === null) throw new Error('the credential is not a token');
  return Buffer.from(hash);
};

async function sessionIdOf(admin: pg.Client, token: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `select id from session where token_hash = $1`,
    [tokenHashOf(token)],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the sign-in left no session row');
  return id;
}

async function vendor(admin: pg.Client): Promise<Principal> {
  const checked = normaliseNewCredential(SECRET);
  if (!checked.ok) throw new Error('the arranged secret is not one a vendor could set');
  const row = await insertVendor(
    admin,
    vendorRow({ secretHash: await hasher.hash('VENDOR_SECRET', checked.credential) }),
  );
  const device = await insertDevice(admin, row.accountId);
  const browser = (build: Build): TestClient => {
    const client = new TestClient({ baseUrl: build.baseUrl, origin: VENDOR_ORIGIN });
    client.seed('melarc_vendor_device', device.credential.token);
    return client;
  };
  return {
    audience: 'VENDOR',
    id: row.accountId,
    async signIn(build) {
      const client = browser(build);
      const response = await client.post(`${API}/auth/vendor/sign-in`, {
        account_identifier: row.accountIdentifier,
        secret: SECRET,
      });
      const session = client.cookie('melarc_session');
      const csrf = client.cookie('melarc_csrf');
      if (response.status !== 200 || session === undefined || csrf === undefined)
        return { response };
      return {
        response,
        held: {
          audience: 'VENDOR',
          sessionId: await sessionIdOf(admin, session),
          csrf,
          on(target) {
            const presented = browser(target);
            presented.seed('melarc_session', session);
            return presented;
          },
        },
      };
    },
  };
}

async function rider(admin: pg.Client): Promise<Principal> {
  const row = await insertRider(admin, riderRow({ pinHash: await hasher.hash('RIDER_PIN', PIN) }));
  const device = await insertRiderDevice(admin, row.id);
  const native = (build: Build): TestClient => new TestClient({ baseUrl: build.baseUrl });
  return {
    audience: 'RIDER',
    id: row.id,
    async signIn(build) {
      const client = native(build);
      const asked = await client.post(
        `${API}/auth/rider/sign-in/challenge`,
        { phone: row.phone },
        { origin: null },
      );
      const { challenge } = asked.json() as { challenge?: string };
      if (asked.status !== 200 || challenge === undefined) return { response: asked };
      const response = await client.post(
        `${API}/auth/rider/sign-in`,
        {
          phone: row.phone,
          pin: PIN,
          challenge,
          device_signature: signChallenge(device.key.privateKey, challenge),
          client_root_signal: 'NOT_DETECTED',
        },
        { origin: null },
      );
      const { access_token: token } = response.json() as { access_token?: string };
      if (response.status !== 200 || token === undefined) return { response };
      return {
        response,
        held: {
          audience: 'RIDER',
          sessionId: await sessionIdOf(admin, token),
          on: (target) => native(target).bearer(token),
        },
      };
    },
  };
}

async function signedIn(principal: Principal, build: Build): Promise<Held> {
  const { response, held } = await principal.signIn(build);
  expect(response.status, `${principal.audience} sign-in on the ${build.name} build`).toBe(200);
  if (held === undefined) throw new Error('the sign-in answered 200 and gave no session');
  return held;
}

/** Everything a refused request could have written: the session's whole row, and the audit ledger. */
async function traces(admin: pg.Client, sessionId: string): Promise<unknown> {
  const { rows } = await admin.query(
    `select (select to_jsonb(s) from session s where s.id = $1) as session,
            (select count(*)::int from audit_event) as audit_events,
            (select count(*)::int from session) as sessions`,
    [sessionId],
  );
  return rows[0];
}

async function sessionState(admin: pg.Client, sessionId: string) {
  const { rows } = await admin.query<{
    terminated: boolean;
    reason: string | null;
    policy_revision: number | null;
  }>(
    `select terminated_at is not null as terminated, termination_reason as reason, policy_revision from session where id = $1`,
    [sessionId],
  );
  return rows[0];
}

async function revocationsOf(admin: pg.Client, sessionId: string) {
  const { rows } = await admin.query<{
    correlation_id: string;
    related_ids: unknown;
    actor_type: string;
  }>(
    `select correlation_id, related_ids, actor_type from audit_event
      where event_code = 'auth.session.authority_revoked' and object_id = $1`,
    [sessionId],
  );
  return rows;
}

/** Every operation a session of the audience can call, as the client calls it. `signOut` last: on a serving build it ends the session. */
function requestsOf(held: Held): readonly ((client: TestClient) => Promise<TestResponse>)[] {
  const reads = [
    (client: TestClient) => client.get(SESSION),
    (client: TestClient) => client.get(REASONS),
  ];
  return held.audience === 'VENDOR'
    ? [
        ...reads,
        (client) => client.get(DEVICES),
        (client) => client.delete(SESSION, held.csrf === undefined ? {} : { csrf: held.csrf }),
      ]
    : [...reads, (client) => client.delete(SESSION)];
}

/** The platform's operational failure: `503`, no business code, nothing in it that names the session or the policy. */
function expectOperationalFailure(response: TestResponse, what: string): void {
  expect(response.status, what).toBe(503);
  const body = response.json() as Record<string, unknown>;
  expect(Object.keys(body).toSorted(), what).toEqual(['message', 'request_id']);
  expect(body.message, what).toBe('Service unavailable');
}

/** The older build refuses every request the session can make, writes nothing, and leaves the session live. */
async function expectRefusedUntouched(world: World, held: Held): Promise<void> {
  const before = await traces(world.admin, held.sessionId);
  for (const send of requestsOf(held)) {
    expectOperationalFailure(
      await send(held.on(world.current)),
      `${held.audience} on the ${world.current.name} build`,
    );
  }
  expect(await traces(world.admin, held.sessionId)).toEqual(before);
  expect((await sessionState(world.admin, held.sessionId))?.terminated).toBe(false);
}

async function readiness(
  build: Build,
): Promise<{ readonly status: number; readonly body: unknown }> {
  // A connection that is reset or refused for a moment (a build that has just been told the release) is asked again, a few times; an answer,
  // whatever it says, is never asked again, so that a build that is slow to say what it should is seen as it is.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${build.baseUrl}/readyz`, {
        signal: AbortSignal.timeout(DEADLINES.request),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** The release, as the migration login applies it: the Vendor's fixed bundle gains `settings.reason.read`, then both compiled policies move. */
async function release(
  migration: pg.Client,
  reduction: boolean,
): Promise<Record<Audience, PolicyChangeResult>> {
  await changeRoleBundle(migration, {
    bundleId: BUNDLE_IDS.vendor,
    grants: [
      {
        permissionKey: 'settings.reason.read',
        hubScope: 'none',
        ownershipScope: 'own',
        tier: null,
      },
    ],
    correlationId: 'release-2:bundle',
  });
  return {
    VENDOR: await changeFixedPolicy(migration, {
      principalType: 'VENDOR',
      reduction,
      correlationId: 'release-2',
    }),
    RIDER: await changeFixedPolicy(migration, {
      principalType: 'RIDER',
      reduction,
      correlationId: 'release-2',
    }),
  };
}

/** A fresh database with the reference seed, and the current build serving it; the newer build starts once the database knows the release. */
async function openWorld(): Promise<Omit<World, 'newer'>> {
  const database = await createTestDatabase();
  const admin = clientFor(database.urlFor('postgres'));
  const migration = clientFor(database.urlFor(MIGRATION_ROLE));
  try {
    await seedReferenceData(database);
    await admin.connect();
    await migration.connect();
    return { database, admin, migration, current: await launch('current', currentMain, database) };
  } catch (error) {
    // A world that did not open is closed here: no caller holds it yet, so none could.
    await closeWorld({ database, admin, migration });
    throw error;
  }
}

/**
 * Closes what a world holds, in the order that leaves nothing behind when a step fails: the builds first (they hold connections to the
 * database), then the two connections, then the database. It takes the part of the world that exists before the newer build starts,
 * so that a hook that failed between opening the world and starting the newer build still closes it.
 */
async function closeWorld(world: Omit<World, 'newer' | 'current'> | undefined): Promise<void> {
  await killAll();
  if (world === undefined) return;
  try {
    await world.admin.end().catch(() => undefined);
    await world.migration.end().catch(() => undefined);
  } finally {
    await world.database.drop();
  }
}

describe('the release declared an addition: the floor stays at 1 and the two builds serve side by side', () => {
  let world: World;
  // Kept as soon as it opens, so that a hook that fails after it still closes it.
  let opened: Omit<World, 'newer'> | undefined;
  const principals = {} as Record<Audience, Principal>;
  const before = {} as Record<Audience, Held>;
  let changes: Record<Audience, PolicyChangeResult>;

  beforeAll(async () => {
    opened = await openWorld();
    principals.VENDOR = await vendor(opened.admin);
    principals.RIDER = await rider(opened.admin);
    // Sessions the current build issued before the release.
    for (const audience of ['VENDOR', 'RIDER'] as const) {
      before[audience] = await signedIn(principals[audience], opened.current);
    }
    changes = await release(opened.migration, false);
    world = {
      ...opened,
      newer: await launch('newer', releaseMain, opened.database),
    };
  });
  afterAll(() => closeWorld(opened));

  it('raises each revision to the newer build’s, keeps the floor, ends nothing, and leaves both builds ready', async () => {
    for (const audience of ['VENDOR', 'RIDER'] as const) {
      expect(changes[audience]).toMatchObject({
        kind: 'ADDITION',
        revision: 2,
        floor: 1,
        endedSessionIds: [],
      });
      expect((await sessionState(world.admin, before[audience].sessionId))?.terminated).toBe(false);
    }
    expect(await readiness(world.current)).toEqual({ status: 200, body: { status: 'ready' } });
    expect(await readiness(world.newer)).toEqual({ status: 200, body: { status: 'ready' } });
  });

  describe.each(['VENDOR', 'RIDER'] as const)('%s', (audience) => {
    // Break caught: a newer build that refuses a session an older build issued while the floor still admits it, or that serves it on a
    // policy recomputed from today's bundle instead of the snapshot it was issued with.
    it('the newer build serves a session the current build issued before the release, on its stored snapshot', async () => {
      const held = before[audience];
      const client = held.on(world.newer);
      expect((await client.get(SESSION)).status).toBe(200);
      // The Rider's snapshot holds the key and the newer build's predicate admits it; the Vendor's was copied before its bundle gained the key.
      expect((await client.get(REASONS)).status).toBe(audience === 'RIDER' ? 200 : 403);
      if (audience === 'VENDOR') expect((await client.get(DEVICES)).status).toBe(200);
      expect((await sessionState(world.admin, held.sessionId))?.policy_revision).toBe(1);
    });

    // Break caught: two builds that differ in a revision number and in nothing they enforce; or an older build that reads a key its own
    // policy gives this audience nothing for as a grant (deny by default, SECURITY_DESIGN.md section 13.10).
    it('a session holding what the release grants is denied on the current build and served on the newer one: the predicate differs', async () => {
      const held = await signedIn(principals[audience], world.current);
      expect((await sessionState(world.admin, held.sessionId))?.policy_revision).toBe(1);
      const snapshot = await world.admin.query<{ keys: string[] }>(
        `select array(select g->>'permission' from jsonb_array_elements(bundle_snapshot->'grants') g) as keys from session where id = $1`,
        [held.sessionId],
      );
      expect(snapshot.rows[0]?.keys).toContain('settings.reason.read');

      const denied = await held.on(world.current).get(REASONS);
      expect(denied.status).toBe(403);
      expect((denied.json() as { code?: string }).code).toBe('PERMISSION_DENIED');
      expect((await held.on(world.newer).get(REASONS)).status).toBe(200);
    });

    // Break caught: an older build that serves a session issued under a policy it does not know (it would apply its own predicate to it),
    // or one that ends that session or records activity while refusing it.
    it('the current build refuses every request of a session the newer build issued, writes nothing, and the newer build then serves it', async () => {
      const held = await signedIn(principals[audience], world.newer);
      expect((await sessionState(world.admin, held.sessionId))?.policy_revision).toBe(
        RELEASE_2_REVISION[audience],
      );

      await expectRefusedUntouched(world, held);
      expect((await held.on(world.newer).get(SESSION)).status).toBe(200);
      expect((await held.on(world.newer).get(REASONS)).status).toBe(200);
    });
  });
});

describe('the release declared a reduction: the floor rises to 2 and the current build is below it', () => {
  let world: World;
  let opened: Omit<World, 'newer'> | undefined;
  const principals = {} as Record<Audience, Principal>;
  const before = {} as Record<Audience, Held>;
  let changes: Record<Audience, PolicyChangeResult>;

  beforeAll(async () => {
    opened = await openWorld();
    principals.VENDOR = await vendor(opened.admin);
    principals.RIDER = await rider(opened.admin);
    for (const audience of ['VENDOR', 'RIDER'] as const) {
      before[audience] = await signedIn(principals[audience], opened.current);
    }
    changes = await release(opened.migration, true);
    world = {
      ...opened,
      newer: await launch('newer', releaseMain, opened.database),
    };
  });
  afterAll(() => closeWorld(opened));

  it('raises the floor to the newer build’s revision, and only the newer build is ready', async () => {
    for (const audience of ['VENDOR', 'RIDER'] as const) {
      expect(changes[audience]).toMatchObject({ kind: 'REDUCTION', revision: 2, floor: 2 });
    }
    expect(await readiness(world.current)).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'policy_superseded' },
    });
    expect(await readiness(world.newer)).toEqual({ status: 200, body: { status: 'ready' } });
  });

  describe.each(['VENDOR', 'RIDER'] as const)('%s', (audience) => {
    // Break caught: a reduction that leaves a session issued under the reduced policy running, or ends it without its record.
    it('the reduction ended the session the current build issued before it, with its record', async () => {
      const { sessionId } = before[audience];
      expect(changes[audience].endedSessionIds).toContain(sessionId);
      expect(await sessionState(world.admin, sessionId)).toEqual({
        terminated: true,
        reason: 'AUTHORITY_CHANGED',
        policy_revision: 1,
      });
      expect(await revocationsOf(world.admin, sessionId)).toEqual([
        {
          correlation_id: 'release-2',
          actor_type: 'SYSTEM',
          related_ids: { principal_type: audience, minimum_revision: 2 },
        },
      ]);
    });

    // Break caught: a build below the floor that still issues a session under the reduced policy, or one that writes while refusing.
    it('the current build refuses to issue a session, and writes nothing', async () => {
      const { rows } = await world.admin.query<{ sessions: number; audit_events: number }>(
        `select (select count(*)::int from session) as sessions, (select count(*)::int from audit_event) as audit_events`,
      );
      const { response } = await principals[audience].signIn(world.current);
      expectOperationalFailure(response, `${audience} sign-in on the current build`);
      expect(
        (
          await world.admin.query(
            `select (select count(*)::int from session) as sessions, (select count(*)::int from audit_event) as audit_events`,
          )
        ).rows[0],
      ).toEqual(rows[0]);
    });

    // Break caught: a session below the floor ended by a build that cannot evaluate the current policy, or left running by the one that
    // can. The lock protocol keeps a below-floor session from committing after the reduction's scan, so the one here is arranged as a row
    // (the facts of the session the reduction ended, live again, with a credential the test holds): what the request check is for.
    it('a session the reduction missed is refused and left alone by the current build, and refused and ended by the newer one', async () => {
      const ended = before[audience].sessionId;
      const { rows } = await world.admin.query<{
        principal_id: string;
        bundle_snapshot: never;
        bundle_id: string;
        bundle_revision: number;
        authorized_hub_ids: string[];
        registered_device_id: string;
      }>(
        `select principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids, registered_device_id from session where id = $1`,
        [ended],
      );
      const facts = rows[0];
      if (facts === undefined) throw new Error('the ended session is not there');
      const credential = tokens.issue();
      const csrf = audience === 'VENDOR' ? tokens.issue() : undefined;
      const missed = await insertSessionRow(
        world.admin,
        sessionRow({
          principalType: audience,
          principalId: facts.principal_id,
          snapshot: facts.bundle_snapshot,
          bundleId: facts.bundle_id,
          bundleRevision: facts.bundle_revision,
          policyRevision: 1,
          authorizedHubIds: facts.authorized_hub_ids,
          registeredDeviceId: facts.registered_device_id,
          tokenHash: Buffer.from(credential.hash),
          csrfTokenHash: csrf === undefined ? null : Buffer.from(csrf.hash),
        }),
      );
      const present = (build: Build): TestClient =>
        audience === 'RIDER'
          ? new TestClient({ baseUrl: build.baseUrl }).bearer(credential.token)
          : (() => {
              const client = new TestClient({ baseUrl: build.baseUrl, origin: VENDOR_ORIGIN });
              client.seed('melarc_session', credential.token);
              return client;
            })();

      const untouched = await traces(world.admin, missed.id);
      expectOperationalFailure(await present(world.current).get(SESSION), 'the obsolete build');
      expect(await traces(world.admin, missed.id)).toEqual(untouched);

      const refused = await present(world.newer).get(SESSION);
      expect(refused.status).toBe(401);
      expect((refused.json() as { code?: string }).code).toBe('SESSION_INVALID');
      expect(await sessionState(world.admin, missed.id)).toEqual({
        terminated: true,
        reason: 'AUTHORITY_CHANGED',
        policy_revision: 1,
      });
      expect(await revocationsOf(world.admin, missed.id)).toHaveLength(1);
    });

    // Break caught: an instance below the floor that serves a request (under the reduced policy), ends the session it cannot judge, or
    // records activity; and a session left unusable by that refusal instead of being served by the next, suitable, instance.
    it('the current build refuses every request of a session the newer build issued, writes nothing, and the newer build serves it', async () => {
      const held = await signedIn(principals[audience], world.newer);
      expect((await sessionState(world.admin, held.sessionId))?.policy_revision).toBe(2);

      await expectRefusedUntouched(world, held);
      const client = held.on(world.newer);
      expect((await client.get(SESSION)).status).toBe(200);
      expect((await client.get(REASONS)).status).toBe(200);
    });
  });
});
