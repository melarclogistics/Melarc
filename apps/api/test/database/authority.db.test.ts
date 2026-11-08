import { randomUUID } from 'node:crypto';

import { Controller, Get, Module, Post } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import type { CompiledFixedPolicy } from '../../src/platform/auth/sessions/session-authority.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import { Self } from '../../src/platform/routes/access-declaration.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { EVERY_SURFACE } from '../../src/test-support/route-options.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { traceStatements } from '../../src/test-support/work-shape.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertSessionRow, sessionRow } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The authority of a session, judged by authentication (S0.26; decision C of 12 October 2026; plan `OB-130`; SECURITY_DESIGN.md
 * sections 13.10 and 13.10a): a session issued from a bundle revision below the bundle's floor, or a Vendor or Rider session issued
 * under a fixed-policy revision below the floor, is `401 SESSION_INVALID` **before CSRF is considered** and is ended and recorded
 * by an instance that is qualified to judge it; an instance that is below the floor itself, older than the session, or that
 * declares no revision for the audience answers the operational `503`, **ends nothing**, and reports `policy_superseded`.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let observer: Observer;
let machinery: Machinery;
const apps: TestApp[] = [];

@Controller('authority')
class AuthorityController {
  @Get('self')
  @Self(EVERY_SURFACE)
  read(): { served: true } {
    return { served: true };
  }

  @Post('write')
  @Self(EVERY_SURFACE)
  write(): { served: true } {
    return { served: true };
  }
}

@Module({ controllers: [AuthorityController] })
class AuthorityModule {}

async function startInstance(compiledFixedPolicy: CompiledFixedPolicy): Promise<TestApp> {
  const loaded = loadConfig(
    validEnv({ DATABASE_URL: database.urlFor(API_RUNTIME_ROLE), DATABASE_POOL_MAX: '3' }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  @Module({})
  class Root {}
  const started = await startTestApp({
    config: loaded.config,
    rootModule: (options) => {
      Module({
        imports: [AppModule.register({ ...options, compiledFixedPolicy }), AuthorityModule],
      })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
  apps.push(started);
  return started;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  observer = await observe(database);
  machinery = assemble(built);
});

afterAll(async () => {
  for (const each of apps) await each.stop();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  instance: TestApp,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
): Promise<Answer> {
  const response = await fetch(
    `${instance.baseUrl}/api/v1/authority/${method === 'GET' ? 'self' : 'write'}`,
    {
      method,
      headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const sessionState = (id: string) =>
  observer.one<{ terminated_at: Date | null; termination_reason: string | null }>(
    `select terminated_at, termination_reason from session where id = $1`,
    [id],
  );

const revocations = (sessionId: string) =>
  observer.rows<{
    enhanced: boolean;
    outcome: string;
    actor_type: string;
    actor_id: string | null;
    reason_code: string | null;
    related_ids: Record<string, unknown>;
    before_after: Record<string, unknown> | null;
  }>(
    `select enhanced, outcome, actor_type, actor_id, reason_code, related_ids, before_after from audit_event
      where event_code = 'auth.session.authority_revoked' and object_id = $1`,
    [sessionId],
  );

/** A reduction of a bundle, as a migration or the seed would make it: the revision up by one and the floor to the new revision. */
const reduceBundle = (bundleId: string) =>
  admin.query(
    `update role_bundle set revision = revision + 1, reduction_floor = revision + 1 where id = $1`,
    [bundleId],
  );
const reduceFixedPolicy = (type: 'VENDOR' | 'RIDER') =>
  admin.query(
    `update fixed_permission_policy set revision = revision + 1, minimum_revision = revision + 1 where principal_type = $1`,
    [type],
  );

/** A Vendor or Rider session row issued under a compiled revision. */
async function fixedSession(
  principalType: 'VENDOR' | 'RIDER',
  policyRevision: number,
): Promise<{ id: string; headers: Record<string, string> }> {
  const issued = machinery.tokens.issue();
  const csrf = machinery.tokens.issue();
  const row = await insertSessionRow(
    admin,
    sessionRow({
      principalType,
      principalId: randomUUID(),
      registeredDeviceId: randomUUID(),
      policyRevision,
      bundleId: principalType === 'RIDER' ? BUNDLE_IDS.rider : BUNDLE_IDS.vendor,
      snapshot: {
        format: 1,
        name: principalType === 'RIDER' ? 'Rider' : 'Vendor',
        audience: principalType,
        privileged: false,
        grants: [],
      },
      tokenHash: Buffer.from(issued.hash),
      csrfTokenHash: principalType === 'RIDER' ? null : Buffer.from(csrf.hash),
    }),
  );
  return {
    id: row.id,
    headers:
      principalType === 'RIDER'
        ? { authorization: `Bearer ${issued.token}` }
        : { cookie: `melarc_session=${issued.token}; melarc_csrf=${csrf.token}` },
  };
}

describe('a staff session below its bundle’s floor (SECURITY_DESIGN.md section 13.10a)', () => {
  // Break caught: authentication that judges expiry and idleness and not authority, so that a session issued from a bundle that has
  // since been reduced keeps its old permissions until it ends by itself.
  it('is 401 SESSION_INVALID, ended with AUTHORITY_CHANGED and recorded once, and a session issued after the reduction is served', async () => {
    const instance = await startInstance({});
    const before = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.opsStaff });
    expect((await call(instance, 'GET', { cookie: before.cookie })).status).toBe(200);

    await reduceBundle(BUNDLE_IDS.opsStaff);
    const after = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.opsStaff });

    const refused = await call(instance, 'GET', { cookie: before.cookie });
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ code: 'SESSION_INVALID', message: 'No usable session' });
    expect(await sessionState(before.issued.session.id)).toMatchObject({
      termination_reason: 'AUTHORITY_CHANGED',
    });
    const events = await revocations(before.issued.session.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      enhanced: true,
      outcome: 'SUCCEEDED',
      actor_type: 'SYSTEM',
      actor_id: null,
      reason_code: 'AUTHORITY_CHANGED',
      related_ids: { bundle_id: BUNDLE_IDS.opsStaff, revision: 2, reduction_floor: 2 },
      before_after: { session: 'ACTIVE_TO_TERMINATED' },
    });

    // The next request meets a session that is ended: refused again, and no second event.
    expect((await call(instance, 'GET', { cookie: before.cookie })).status).toBe(401);
    expect(await revocations(before.issued.session.id)).toHaveLength(1);
    expect((await call(instance, 'GET', { cookie: after.cookie })).status).toBe(200);
  });

  // Break caught (OB-130; permission-enforcement.md section 5.1): the floor comparison made after CSRF, so that an unsafe request on
  // a session that is no longer valid meets the CSRF refusal first, and has been counted before it.
  it('is refused 401 before the CSRF check is considered, on an unsafe request with no token and a hostile Origin', async () => {
    const instance = await startInstance({});
    const stale = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.seniorOps });
    await reduceBundle(BUNDLE_IDS.seniorOps);

    const answer = await call(instance, 'POST', {
      cookie: stale.cookie,
      origin: 'https://evil.example',
    });

    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe('SESSION_INVALID');
    expect(await sessionState(stale.issued.session.id)).toMatchObject({
      termination_reason: 'AUTHORITY_CHANGED',
    });
  });

  // Break caught: a session at the floor, or above it, ended; the floor is "below", not "at or below".
  it('serves a session issued at exactly the floor', async () => {
    const instance = await startInstance({});
    await reduceBundle(BUNDLE_IDS.platformAdmin);
    const atFloor = await staffPersona(machinery, admin, {
      roleBundleId: BUNDLE_IDS.platformAdmin,
    });
    const floor = await admin.query<{ reduction_floor: number }>(
      `select reduction_floor from role_bundle where id = $1`,
      [BUNDLE_IDS.platformAdmin],
    );

    expect(atFloor.issued.session.authority.bundleRevision).toBe(floor.rows[0]?.reduction_floor);
    expect((await call(instance, 'GET', { cookie: atFloor.cookie })).status).toBe(200);
  });

  // Break caught: the comparison taking a policy lock, or any lock: a read racing a reduction is ordered before it, and a request
  // that holds a session row must never wait for a policy lock (section 13.10a).
  it('takes no advisory lock to decide it', async () => {
    const instance = await startInstance({});
    const persona = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.finance });

    const traced = await traceStatements(API_RUNTIME_ROLE, () =>
      call(instance, 'GET', { cookie: persona.cookie }),
    );

    expect(traced.result.status).toBe(200);
    // The policy locks of a reader or a mutation are the shared form. The two exclusive calls that remain are the rate limiter's own
    // (its key and its capacity), taken in a transaction of its own that holds no session row.
    const advisory = traced.statements.filter((statement) => statement.includes('pg_advisory'));
    expect(advisory.filter((statement) => statement.includes('_shared'))).toEqual([]);
    expect(advisory).toHaveLength(2);
  });
});

describe('a Vendor or a Rider session and the fixed policy (SECURITY_DESIGN.md section 13.10, part 2)', () => {
  // Break caught: a session issued under a revision below the floor served by an instance that is qualified to judge it, or ended
  // by one that is not.
  it('is served while at or above the floor, and 401 and ended by a current instance once below it', async () => {
    const current = await startInstance({ VENDOR: 2, RIDER: 2 });
    const vendor = await fixedSession('VENDOR', 1);
    const rider = await fixedSession('RIDER', 1);
    await reduceFixedPolicy('VENDOR');
    await reduceFixedPolicy('RIDER');
    const newer = await fixedSession('VENDOR', 2);

    const vendorAnswer = await call(current, 'GET', vendor.headers);
    const riderAnswer = await call(current, 'GET', rider.headers);

    expect(vendorAnswer.status).toBe(401);
    expect(vendorAnswer.body.code).toBe('SESSION_INVALID');
    expect(riderAnswer.status).toBe(401);
    expect(await sessionState(vendor.id)).toMatchObject({
      termination_reason: 'AUTHORITY_CHANGED',
    });
    expect(await sessionState(rider.id)).toMatchObject({ termination_reason: 'AUTHORITY_CHANGED' });
    expect((await revocations(vendor.id))[0]?.related_ids).toEqual({
      principal_type: 'VENDOR',
      minimum_revision: 2,
    });
    expect((await call(current, 'GET', newer.headers)).status).toBe(200);
  });

  // Break caught: an obsolete instance (one below the floor) ending the session it cannot judge, or answering 401: the session is
  // valid and the instance is the wrong one. Nothing is ended and the next request, reaching a suitable instance, succeeds.
  it('is 503, with nothing ended, from an instance below the floor; and a current instance then serves it', async () => {
    const [vendorFixedRevision] = [3];
    await reduceFixedPolicy('VENDOR');
    const obsolete = await startInstance({ VENDOR: 2, RIDER: 2 });
    const current = await startInstance({ VENDOR: vendorFixedRevision, RIDER: 3 });
    const session = await fixedSession('VENDOR', 3);

    const refused = await call(obsolete, 'GET', session.headers);

    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({
      message: 'Service unavailable',
      request_id: expect.any(String) as unknown,
    });
    expect(await sessionState(session.id)).toMatchObject({ terminated_at: null });
    expect(await revocations(session.id)).toEqual([]);
    expect((await call(current, 'GET', session.headers)).status).toBe(200);
  });

  // Break caught: an instance older than the session serving it on a policy it does not know.
  it('is 503 from an instance older than the revision the session was issued under, and ends nothing', async () => {
    await reduceFixedPolicy('RIDER');
    const older = await startInstance({ VENDOR: 3, RIDER: 3 });
    const session = await fixedSession('RIDER', 4);
    await reduceFixedPolicy('RIDER');
    // The floor is now 5; the session at 4 is below it for a current instance and the instance at 3 is below the floor itself.
    const answer = await call(older, 'GET', session.headers);

    expect(answer.status).toBe(503);
    expect(await sessionState(session.id)).toMatchObject({ terminated_at: null });
  });

  const currentFloor = async (type: 'VENDOR' | 'RIDER'): Promise<number> =>
    Number(
      (
        await admin.query<{ minimum_revision: number }>(
          `select minimum_revision from fixed_permission_policy where principal_type = $1`,
          [type],
        )
      ).rows[0]?.minimum_revision,
    );

  // Break caught (a deliberate break of the instance check): an instance that is below the floor judging a session that is itself below
  // it, so that an obsolete instance ends a session it cannot be sure about. The session is valid and the instance is the wrong one:
  // 503, nothing ended; the current instance then ends it, which only a qualified instance does.
  it('is 503 from an instance below the floor even for a session that is itself below it, and ends nothing; a current instance then ends it', async () => {
    await reduceFixedPolicy('VENDOR');
    const floor = await currentFloor('VENDOR');
    const obsolete = await startInstance({ VENDOR: floor - 1, RIDER: floor });
    const current = await startInstance({ VENDOR: floor, RIDER: floor });
    const session = await fixedSession('VENDOR', floor - 1);

    const refused = await call(obsolete, 'GET', session.headers);

    expect(refused.status).toBe(503);
    expect(await sessionState(session.id)).toMatchObject({ terminated_at: null });
    expect(await revocations(session.id)).toEqual([]);
    expect((await call(current, 'GET', session.headers)).status).toBe(401);
    expect(await sessionState(session.id)).toMatchObject({
      termination_reason: 'AUTHORITY_CHANGED',
    });
  });

  // Break caught (a deliberate break of the age check): an instance serving a session that a newer build issued, on rules it does not
  // know, though the session is above the floor and nothing else is wrong. Here the instance is at the floor and not below it, so only
  // its age is what refuses.
  it('is 503 from an instance that is at the floor but older than the session, and ends nothing; a build that knows the revision serves it', async () => {
    const floor = await currentFloor('VENDOR');
    const older = await startInstance({ VENDOR: floor, RIDER: floor });
    const newer = await startInstance({ VENDOR: floor + 1, RIDER: floor + 1 });
    const session = await fixedSession('VENDOR', floor + 1);

    const refused = await call(older, 'GET', session.headers);

    expect(refused.status).toBe(503);
    expect(await sessionState(session.id)).toMatchObject({ terminated_at: null });
    expect((await call(newer, 'GET', session.headers)).status).toBe(200);
  });

  // Break caught: an instance that declares no revision for the audience serving it, or ending its sessions.
  it('is 503 from an instance that declares no revision for the audience, and ends nothing', async () => {
    const none = await startInstance({});
    const session = await fixedSession('VENDOR', 3);

    const answer = await call(none, 'GET', session.headers);

    expect(answer.status).toBe(503);
    expect(await sessionState(session.id)).toMatchObject({ terminated_at: null });
  });

  // Break caught: the staff path consulting the fixed policy, so that an instance with nothing declared refuses staff.
  it('does not ask a staff session for the fixed policy', async () => {
    const none = await startInstance({});
    const persona = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.finance });

    const traced = await traceStatements(API_RUNTIME_ROLE, () =>
      call(none, 'GET', { cookie: persona.cookie }),
    );

    expect(traced.result.status).toBe(200);
    expect(
      traced.statements.some((statement) => statement.includes('fixed_permission_policy')),
    ).toBe(false);
  });
});

describe('readiness: policy_superseded (SECURITY_DESIGN.md section 13.10)', () => {
  // Break caught: an instance below the floor still reporting ready, so the platform keeps sending it traffic it can only refuse; or
  // reporting a dependency down for a policy it could read.
  it('reports not ready with policy_superseded for an instance below the floor, and ready for a current one', async () => {
    const floors = await admin.query<{ principal_type: string; minimum_revision: number }>(
      `select principal_type, minimum_revision from fixed_permission_policy order by principal_type`,
    );
    const top = Math.max(...floors.rows.map((row) => row.minimum_revision));
    const obsolete = await startInstance({ VENDOR: top - 1, RIDER: top - 1 });
    const current = await startInstance({ VENDOR: top, RIDER: top });

    const stale = await fetch(`${obsolete.baseUrl}/readyz`);
    const fresh = await fetch(`${current.baseUrl}/readyz`);

    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ status: 'not_ready', reason: 'policy_superseded' });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ status: 'ready' });
  });

  it('is ready for an instance that declares no revision: it serves nothing of the audiences and is not asked', async () => {
    const none = await startInstance({});

    expect((await fetch(`${none.baseUrl}/readyz`)).status).toBe(200);
  });
});
