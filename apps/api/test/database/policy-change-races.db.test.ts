import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Module, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { OPERATION_RUNNER } from '../../src/platform/authorization/authorization-providers.js';
import { authorizationOf } from '../../src/platform/authorization/authorized-request.js';
import type { OperationRunner } from '../../src/platform/authorization/operation-runner.js';
import {
  changeRoleBundle,
  PolicyChangeError,
  type PolicyChangeResult,
} from '../../src/platform/authorization/policy-change/policy-change.js';
import {
  API_RUNTIME_ROLE,
  loadConfig,
  type DatabaseDeadlines,
} from '../../src/platform/config/load-config.js';
import { DatabaseDeadlineError } from '../../src/platform/database/database-failures.js';
import {
  AUTH_POLICY_BUNDLE,
  bundleLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import { classifyFailure } from '../../src/platform/http/operational-failure.js';
import { currentRequestContext } from '../../src/platform/logging/request-context.js';
import { RequiresPermission } from '../../src/platform/routes/access-declaration.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { OPS_ONLY } from '../../src/test-support/route-options.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { insertStaff, staffRow } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery, type StaffPersona } from './support/personas.js';
import {
  eventually,
  grant,
  newBundle,
  READ_STAFF,
  READ_VENDOR,
  waitUntilBlocked,
  type Grant,
} from './support/policy-fixtures.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.27, the races of SECURITY_DESIGN.md section 13.10a on a real PostgreSQL, with the runtime login for the sign-in and the
 * state-changing request and the migration login for the change (`GBT-B12`, `GBT-B13`; obligations 2, 3, 4, 5 and 6):
 *
 * - a reduction racing a sign-in, in both orders: no session with the old snapshot is left `ACTIVE`, and one that starts after the
 *   reduction reads the reduced content;
 * - a reduction racing a state-changing request, in both orders: a request already past its lock finishes first, and one that waits
 *   for the lock meets a session that has ended and does nothing;
 * - two writers on one bundle serialise, a writer on one bundle does not hold up a sign-in on another with a distinct lock key;
 * - a lock that cannot be taken in time leaves nothing half applied, and answers the platform's generic failure to a sign-in.
 *
 * Every wait is a latch the server reports (`pg_stat_activity`, `pg_locks`), not a pause: a step is released when the statement it
 * is waiting for is seen blocked, never after an interval. Randomised interleavings and starvation on the pinned server are S0.64's.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let migration: pg.Client;
let observer: Observer;
let machinery: Machinery;
let app: TestApp;

const origins = (() => {
  const loaded = loadConfig(validEnv());
  if (!loaded.ok) throw new Error('the configuration was refused');
  return loaded.config.origins;
})();

/** What the route under test records, and the gate that holds its work open. */
const hooks = {
  log: [] as string[],
  gate: Promise.resolve(),
  release: (): void => undefined,
};
function armGate(): void {
  hooks.log.length = 0;
  hooks.gate = new Promise<void>((resolve) => {
    hooks.release = resolve;
  });
}

@Controller('race')
class RaceController {
  constructor(@Inject(OPERATION_RUNNER) private readonly runner: OperationRunner) {}

  /** A state-changing request: it takes the shared policy locks and holds them while its work waits at the gate. */
  @Post('mutate')
  @RequiresPermission('staff.read', OPS_ONLY)
  mutate(@Req() request: Request): Promise<{ done: true }> {
    const authorized = authorizationOf(request);
    if (authorized === undefined) throw new Error('no authorization decision was held');
    return this.runner.mutate(
      authorized,
      currentRequestContext()?.requestId ?? randomUUID(),
      async () => {
        hooks.log.push('work-started');
        await hooks.gate;
        hooks.log.push('work-finished');
        return { done: true as const };
      },
    );
  }

  /** A mistake of a use case: a state-changing request sent down the lock-free path. The platform refuses it before it opens anything. */
  @Post('read-by-mistake')
  @RequiresPermission('staff.read', OPS_ONLY)
  readByMistake(@Req() request: Request): Promise<{ served: true }> {
    const authorized = authorizationOf(request);
    if (authorized === undefined) throw new Error('no authorization decision was held');
    return this.runner.read(authorized, currentRequestContext()?.requestId ?? randomUUID(), () => {
      hooks.log.push('work-started');
      return Promise.resolve({ served: true as const });
    });
  }

  /** A read: it takes no policy lock. */
  @Get('read')
  @RequiresPermission('staff.read', OPS_ONLY)
  read(@Req() request: Request): Promise<{ served: true }> {
    const authorized = authorizationOf(request);
    if (authorized === undefined) throw new Error('no authorization decision was held');
    return this.runner.read(authorized, currentRequestContext()?.requestId ?? randomUUID(), () =>
      Promise.resolve({ served: true as const }),
    );
  }
}

@Module({ controllers: [RaceController] })
class RaceModule {}

@Module({})
class Root {}

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 3 });
  machinery = assemble(built);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  migration = clientFor(database.urlFor(MIGRATION_ROLE));
  await migration.connect();
  observer = await observe(database);
  const loaded = loadConfig(
    validEnv({ DATABASE_URL: database.urlFor(API_RUNTIME_ROLE), DATABASE_POOL_MAX: '3' }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  app = await startTestApp({
    config: loaded.config,
    rootModule: (options) => {
      Module({
        imports: [
          AppModule.register({ ...options, compiledFixedPolicy: { VENDOR: 1, RIDER: 1 } }),
          RaceModule,
        ],
      })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
});

afterAll(async () => {
  hooks.release();
  await app.stop();
  await built.close();
  await migration.end();
  await admin.end();
  await observer.close();
  await database.drop();
});

const bundleOf = (grants: readonly Grant[]) => newBundle(admin, grants);
const bundleRow = (id: string) =>
  observer.one<{ revision: number; reduction_floor: number }>(
    `select revision, reduction_floor from role_bundle where id = $1`,
    [id],
  );
const sessionState = (id: string) =>
  observer.one<{ terminated_at: Date | null; termination_reason: string | null }>(
    `select terminated_at, termination_reason from session where id = $1`,
    [id],
  );
const grantsPayload = (grants: readonly Grant[]) =>
  JSON.stringify(
    grants.map((each) => ({
      permission_key: each.permissionKey,
      hub_scope: each.hubScope,
      ownership_scope: each.ownershipScope,
      tier: each.tier,
    })),
  );

/** A staff member of the bundle who can sign in, and what signing in for them takes. */
async function staffOf(bundle: string) {
  const identity = await insertStaff(admin, staffRow({ roleBundleId: bundle }));
  const signIn = () =>
    machinery.issuer.issue({
      principal: { type: 'STAFF', id: identity.id },
      correlationId: `race-${identity.id.slice(0, 8)}`,
      verifiedCredentialGeneration: identity.credentialGeneration,
    });
  return { identity, signIn };
}

/** The advisory locks one backend holds or waits for, as the server reports them. */
async function advisoryOf(pid: number) {
  const { rows } = await admin.query(
    `select classid::bigint as class, objid::bigint as key, mode, granted
       from pg_locks where locktype = 'advisory' and pid = $1 order by granted desc, classid, objid::bigint`,
    [pid],
  );
  return rows.map((row: Record<string, unknown>) => ({
    class: Number(row.class),
    key: Number(row.key) | 0,
    mode: String(row.mode),
    granted: row.granted === true,
  }));
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}
const mutate = async (persona: StaffPersona): Promise<Answer> => {
  const response = await fetch(`${app.baseUrl}/api/v1/race/mutate`, {
    method: 'POST',
    headers: {
      cookie: persona.cookie,
      'x-csrf-token': persona.issued.csrfToken ?? '',
      origin: origins.ops,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const read = async (persona: StaffPersona): Promise<Answer> => {
  const response = await fetch(`${app.baseUrl}/api/v1/race/read`, {
    headers: { cookie: persona.cookie },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

type Settled<T> = Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
/** The settled outcome of a promise that has not been awaited yet, so that its rejection is not raised before the test reads it. */
const settled = <T>(promise: Promise<T>): Settled<T> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe('a reduction racing a sign-in, both orders (SECURITY_DESIGN.md section 13.10a, obligation 2; GBT-B12)', () => {
  // Break caught: a reduction that does not wait for a sign-in that already holds the bundle, so that the session the sign-in is
  // about to write, from the content as it was, is missed by the scan that ends the sessions below the floor and stays ACTIVE with
  // a permission the bundle no longer holds.
  it('ends the session of a sign-in that was ahead of it: no session with the old snapshot is left ACTIVE', async () => {
    const bundle = await bundleOf([grant(READ_STAFF), grant(READ_VENDOR)]);
    const staff = await staffOf(bundle);
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    await holder.query('begin');
    // The sign-in takes the shared policy lock and then the identity row; holding the row holds the sign-in between the two.
    await holder.query(`select id from staff_identity where id = $1 for update`, [
      staff.identity.id,
    ]);
    let reduction: Settled<PolicyChangeResult> | undefined;
    try {
      const signingIn = settled(staff.signIn());
      const waiting = await waitUntilBlocked(admin, database.name, /for no key update/i);
      // It holds the bundle's shared lock while it waits for the row.
      expect(await advisoryOf(waiting.pid)).toEqual([
        { class: AUTH_POLICY_BUNDLE, key: bundleLockKey(bundle), mode: 'ShareLock', granted: true },
      ]);

      reduction = settled(
        changeRoleBundle(
          migration,
          { bundleId: bundle, grants: [grant(READ_STAFF)], correlationId: 'race-issue-first' },
          { lockTimeoutMs: 20_000 },
        ),
      );
      await waitUntilBlocked(admin, database.name, /change_role_bundle/);
      expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });

      await holder.query('rollback');
      const issued = await signingIn;
      const reduced = await reduction;

      if (!issued.ok) throw issued.error;
      if (!reduced.ok) throw reduced.error;
      // The sign-in wrote its session from the content it locked: revision 1, with both grants.
      expect(issued.value.session.authority.bundleRevision).toBe(1);
      expect(issued.value.session.authority.snapshot.grants).toHaveLength(2);
      // And the reduction, which waited for it, ended it.
      expect(reduced.value).toMatchObject({ kind: 'REDUCTION', revision: 2, floor: 2 });
      expect(reduced.value.endedSessionIds).toEqual([issued.value.session.id]);
      expect(await sessionState(issued.value.session.id)).toMatchObject({
        termination_reason: 'AUTHORITY_CHANGED',
      });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
      await reduction;
    }
  });

  // Break caught: a sign-in that reads the bundle before the reduction commits and writes after it, leaving a session at the old
  // revision that nobody ends; or one that starts after the reduction and still copies the old content.
  it('makes a sign-in that starts after the reduction wait for it, and read the reduced content', async () => {
    const bundle = await bundleOf([grant(READ_STAFF), grant(READ_VENDOR)]);
    const staff = await staffOf(bundle);
    await migration.query('begin');
    try {
      const reduced = await migration.query<{ result: { kind: string } }>(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'race-reduction-first') as result`,
        [bundle, grantsPayload([grant(READ_STAFF)])],
      );
      expect(reduced.rows[0]?.result.kind).toBe('REDUCTION');

      const signingIn = settled(staff.signIn());
      const waiting = await waitUntilBlocked(admin, database.name, /pg_advisory_xact_lock_shared/);
      expect(waiting.waitEvent).toBe('advisory');
      // Nothing of the sign-in is written while it waits.
      expect(await observer.count('session', { principal_id: staff.identity.id })).toBe(0);

      await migration.query('commit');
      const issued = await signingIn;

      if (!issued.ok) throw issued.error;
      expect(issued.value.session.authority.bundleRevision).toBe(2);
      expect(issued.value.session.authority.snapshot.grants.map((each) => each.permission)).toEqual(
        [READ_STAFF],
      );
      expect((await sessionState(issued.value.session.id))?.terminated_at).toBeNull();
    } finally {
      await migration.query('rollback').catch(() => undefined);
    }
  });

  // Break caught (GBT-B13, the race half): an addition that ends the session of a sign-in that was ahead of it, or that makes the
  // sign-in copy a half-written bundle. The session keeps the snapshot it was issued with, and is not ended.
  it('leaves the session of a sign-in that was ahead of an addition ACTIVE, with the snapshot it was issued with', async () => {
    const bundle = await bundleOf([grant(READ_STAFF)]);
    const staff = await staffOf(bundle);
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    await holder.query('begin');
    await holder.query(`select id from staff_identity where id = $1 for update`, [
      staff.identity.id,
    ]);
    let addition: Settled<PolicyChangeResult> | undefined;
    try {
      const signingIn = settled(staff.signIn());
      await waitUntilBlocked(admin, database.name, /for no key update/i);
      addition = settled(
        changeRoleBundle(
          migration,
          {
            bundleId: bundle,
            grants: [grant(READ_STAFF), grant(READ_VENDOR)],
            correlationId: 'race-addition',
          },
          { lockTimeoutMs: 20_000 },
        ),
      );
      await waitUntilBlocked(admin, database.name, /change_role_bundle/);

      await holder.query('rollback');
      const issued = await signingIn;
      const added = await addition;

      if (!issued.ok) throw issued.error;
      if (!added.ok) throw added.error;
      expect(issued.value.session.authority.bundleRevision).toBe(1);
      expect(added.value).toMatchObject({
        kind: 'ADDITION',
        revision: 2,
        floor: 1,
        endedSessionIds: [],
      });
      expect((await sessionState(issued.value.session.id))?.terminated_at).toBeNull();
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
      await addition;
    }
  });
});

describe('a reduction racing a state-changing request, both orders (obligation 3; GBT-B12)', () => {
  // Break caught: a reduction that does not wait for a mutation already past its lock, so that the effect of an authorized request
  // lands after the authority it relied on has been ended; or a mutation cut off in the middle. It finishes first, whole, and the
  // reduction proceeds after it and ends the session.
  it('lets a request already past its lock finish whole before the reduction proceeds', async () => {
    const bundle = await bundleOf([grant(READ_STAFF)]);
    const persona = await staffPersona(machinery, admin, { roleBundleId: bundle });
    armGate();
    const request = mutate(persona);
    let reduction: Settled<PolicyChangeResult> | undefined;
    try {
      await eventually(() => hooks.log.includes('work-started'), 'the request to reach its work');
      // It holds the shared lock of its session's bundle while its work runs.
      const holders = await admin.query(
        `select pid from pg_locks where locktype = 'advisory' and classid = $1::oid and objid = (($2::bigint + 4294967296) % 4294967296)::oid and granted and mode = 'ShareLock'`,
        [AUTH_POLICY_BUNDLE, bundleLockKey(bundle)],
      );
      expect(holders.rows).toHaveLength(1);

      reduction = settled(
        changeRoleBundle(
          migration,
          { bundleId: bundle, grants: [], correlationId: 'race-mutation-first' },
          { lockTimeoutMs: 20_000 },
        ).then((result) => {
          hooks.log.push('reduction-committed');
          return result;
        }),
      );
      await waitUntilBlocked(admin, database.name, /change_role_bundle/);
      expect(hooks.log).toEqual(['work-started']);
      expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });

      hooks.release();
      const answer = await request;
      const reduced = await reduction;

      expect(answer.status).toBe(201);
      if (!reduced.ok) throw reduced.error;
      expect(hooks.log).toEqual(['work-started', 'work-finished', 'reduction-committed']);
      expect(reduced.value.endedSessionIds).toEqual([persona.issued.session.id]);
      // The next request on that session is refused: it has ended.
      expect((await read(persona)).status).toBe(401);
    } finally {
      hooks.release();
      await request.catch(() => undefined);
      await reduction;
    }
  });

  // Break caught: a mutation that waited for the lock and then ran on the authority it had read before it waited, doing what the
  // reduction ended the right to do. It meets a session that has ended, answers 401, and writes nothing.
  it('makes a request that waits for a reduction’s lock meet an ended session, and do nothing', async () => {
    const bundle = await bundleOf([grant(READ_STAFF)]);
    const persona = await staffPersona(machinery, admin, { roleBundleId: bundle });
    armGate();
    await migration.query('begin');
    let request: Promise<Answer> | undefined;
    try {
      await migration.query(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'race-reduction-first') as result`,
        [bundle, grantsPayload([])],
      );

      request = mutate(persona);
      const waiting = await waitUntilBlocked(admin, database.name, /pg_advisory_xact_lock_shared/);
      expect(waiting.waitEvent).toBe('advisory');
      expect(hooks.log).toEqual([]);

      await migration.query('commit');
      const answer = await request;

      expect(answer.status).toBe(401);
      expect(answer.body).toMatchObject({ code: 'SESSION_INVALID' });
      // Its work never ran: nothing it would have written was written.
      expect(hooks.log).toEqual([]);
      expect(await sessionState(persona.issued.session.id)).toMatchObject({
        termination_reason: 'AUTHORITY_CHANGED',
      });
    } finally {
      hooks.release();
      await migration.query('rollback').catch(() => undefined);
      await request?.catch(() => undefined);
    }
  });

  // Break caught (found by a deliberate break of the guard): a state-changing request sent down the path that takes no policy lock, so
  // that an authorized mutation could outlive a reduction that ended the authority it relied on. The platform refuses it at the first
  // call and nothing is opened, whatever the use case meant.
  it('refuses a state-changing request that a use case sends down the lock-free read path, before its work runs', async () => {
    const bundle = await bundleOf([grant(READ_STAFF)]);
    const persona = await staffPersona(machinery, admin, { roleBundleId: bundle });
    armGate();

    const response = await fetch(`${app.baseUrl}/api/v1/race/read-by-mistake`, {
      method: 'POST',
      headers: {
        cookie: persona.cookie,
        'x-csrf-token': persona.issued.csrfToken ?? '',
        origin: origins.ops,
        'content-type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(500);
    expect(hooks.log).toEqual([]);
    expect((await sessionState(persona.issued.session.id))?.terminated_at).toBeNull();
  });

  // Break caught (section 13.10a, "A read-only request: none"): a read that takes a policy lock, so that a reduction in progress holds
  // up every page load. A read racing a reduction is simply ordered before it: served while the reduction is open, refused once it
  // has committed.
  it('serves a read while a reduction is open, without waiting for it, and refuses it once the reduction has committed', async () => {
    const bundle = await bundleOf([grant(READ_STAFF)]);
    const persona = await staffPersona(machinery, admin, { roleBundleId: bundle });
    await migration.query('begin');
    try {
      await migration.query(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'race-read') as result`,
        [bundle, grantsPayload([])],
      );

      const during = await read(persona);

      expect(during.status).toBe(200);
      await migration.query('commit');
      expect((await read(persona)).status).toBe(401);
    } finally {
      await migration.query('rollback').catch(() => undefined);
    }
  });
});

describe('writers (obligations 5 and 6)', () => {
  // Break caught: two writers of one bundle interleaving, so that the second computes its change from content the first has not
  // yet committed and the revision is raised twice from the same value. The second waits for the first and reads what it committed.
  it('serialises two writers on one bundle: the second reads the content the first committed', async () => {
    const bundle = await bundleOf([grant(READ_STAFF)]);
    const second = clientFor(database.urlFor(MIGRATION_ROLE));
    await second.connect();
    await migration.query('begin');
    let following: Settled<PolicyChangeResult> | undefined;
    try {
      // The first writer adds a grant and has not committed.
      const first = await migration.query<{ result: { kind: string } }>(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'writer-one') as result`,
        [bundle, grantsPayload([grant(READ_STAFF), grant(READ_VENDOR)])],
      );
      expect(first.rows[0]?.result.kind).toBe('ADDITION');

      // The second removes it again, from the content as it will be once the first commits.
      following = settled(
        changeRoleBundle(
          second,
          { bundleId: bundle, grants: [grant(READ_STAFF)], correlationId: 'writer-two' },
          { lockTimeoutMs: 20_000 },
        ),
      );
      await waitUntilBlocked(admin, database.name, /change_role_bundle/);
      expect(await bundleRow(bundle)).toMatchObject({ revision: 1 });

      await migration.query('commit');
      const result = await following;

      if (!result.ok) throw result.error;
      // Judged against the added content, removing the grant is a reduction, and it is the third revision.
      expect(result.value).toMatchObject({ kind: 'REDUCTION', revision: 3, floor: 3 });
      expect(await bundleRow(bundle)).toMatchObject({ revision: 3, reduction_floor: 3 });
    } finally {
      await migration.query('rollback').catch(() => undefined);
      await following;
      await second.end();
    }
  });

  // Break caught (obligation 5, second half): the policy lock of one bundle holding up a sign-in on another, so that a change to one
  // bundle stops everybody signing in. Bundles with distinct lock keys do not contend; the control is a sign-in on the bundle being
  // changed, which does wait.
  it('does not hold up a sign-in on a bundle with a distinct lock key, and does hold up one on the bundle being changed', async () => {
    const changing = await bundleOf([grant(READ_STAFF)]);
    const other = await bundleOf([grant(READ_STAFF)]);
    expect(bundleLockKey(changing)).not.toBe(bundleLockKey(other));
    const staffOnOther = await staffOf(other);
    const staffOnChanging = await staffOf(changing);
    await migration.query('begin');
    let controlSignIn: Settled<Awaited<ReturnType<typeof staffOnChanging.signIn>>> | undefined;
    try {
      await migration.query(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'writer-holds') as result`,
        [changing, grantsPayload([])],
      );

      const unblocked = await Promise.race([
        staffOnOther.signIn().then((issued) => ({ issued })),
        new Promise<{ issued?: undefined }>((resolve) =>
          setTimeout(() => {
            resolve({});
          }, 5_000),
        ),
      ]);
      expect(
        unblocked.issued,
        'the sign-in on the other bundle waited for the writer',
      ).toBeDefined();

      controlSignIn = settled(staffOnChanging.signIn());
      await waitUntilBlocked(admin, database.name, /pg_advisory_xact_lock_shared/);
      await migration.query('commit');
      const issued = await controlSignIn;

      if (!issued.ok) throw issued.error;
      // It waited, and then read the reduced bundle.
      expect(issued.value.session.authority.bundleRevision).toBe(2);
    } finally {
      await migration.query('rollback').catch(() => undefined);
      await controlSignIn;
    }
  });

  // Break caught (obligation 6, the writer): a change that proceeds without its lock, or half applies when the lock cannot be taken in
  // time. The transaction ends before it has read or written anything, and everything is as it was.
  it('fails visibly when its lock cannot be taken in time, and leaves nothing half applied', async () => {
    const bundle = await bundleOf([grant(READ_STAFF), grant(READ_VENDOR)]);
    const persona = await staffPersona(machinery, admin, { roleBundleId: bundle });
    const blocker = clientFor(database.urlFor('postgres'));
    await blocker.connect();
    await blocker.query('begin');
    await blocker.query(`select pg_advisory_xact_lock($1::int4, $2::int4)`, [
      AUTH_POLICY_BUNDLE,
      bundleLockKey(bundle),
    ]);
    try {
      const started = Date.now();
      const failure = await changeRoleBundle(
        migration,
        { bundleId: bundle, grants: [grant(READ_STAFF)], correlationId: 'race-timeout' },
        { lockTimeoutMs: 300 },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PolicyChangeError);
      expect(failure).toMatchObject({ failure: 'LOCK_TIMEOUT', sqlState: '55P03' });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
      expect(await observer.count('role_bundle_grant', { bundle_id: bundle })).toBe(2);
      expect((await sessionState(persona.issued.session.id))?.terminated_at).toBeNull();
      expect(
        await observer.count('audit_event', {
          event_code: 'auth.session.authority_revoked',
          object_id: persona.issued.session.id,
        }),
      ).toBe(0);
      // The connection is usable after it, and the timeout it was given was the transaction's and is gone with it.
      expect((await migration.query('show lock_timeout')).rows[0]).toEqual({ lock_timeout: '0' });
    } finally {
      await blocker.query('rollback');
      await blocker.end();
    }
    // With the lock released the same change goes through.
    const done = await changeRoleBundle(migration, {
      bundleId: bundle,
      grants: [grant(READ_STAFF)],
      correlationId: 'race-after-release',
    });
    expect(done).toMatchObject({ kind: 'REDUCTION', revision: 2 });
    expect(done.endedSessionIds).toEqual([persona.issued.session.id]);
  });
});

describe('a sign-in whose lock cannot be taken in time (obligation 6, the sign-in)', () => {
  /** Small bounds, so that the wait for a held lock reaches its deadline. */
  const FAST: DatabaseDeadlines = {
    acquireTimeoutMs: 2_000,
    lockTimeoutMs: 400,
    statementTimeoutMs: 1_500,
    idleInTransactionTimeoutMs: 3_000,
    transactionTimeoutMs: 4_000,
    maxWaiters: 10,
  };

  // Break caught: a sign-in that waits for a reduction for ever, or that gives up and issues a session anyway. It answers the
  // platform's generic operational failure (a retryable 503), no session exists, and no event says one was issued.
  it('answers the generic operational failure and issues no session, while a reduction holds the lock', async () => {
    const bundle = await bundleOf([grant(READ_STAFF)]);
    const staff = await staffOf(bundle);
    const fast = buildService(database, { poolMax: 2, deadlines: FAST });
    const fastMachinery = assemble(fast);
    await migration.query('begin');
    try {
      await migration.query(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'race-held') as result`,
        [bundle, grantsPayload([])],
      );

      const failure = await fastMachinery.issuer
        .issue({
          principal: { type: 'STAFF', id: staff.identity.id },
          correlationId: 'race-timeout-signin',
          verifiedCredentialGeneration: staff.identity.credentialGeneration,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(classifyFailure(failure)).toEqual({ kind: 'operational' });
      expect(failure).toBeInstanceOf(DatabaseDeadlineError);
      expect(await observer.count('session', { principal_id: staff.identity.id })).toBe(0);
      expect(
        await observer.count('audit_event', {
          event_code: 'auth.session.issued',
          actor_id: staff.identity.id,
        }),
      ).toBe(0);
    } finally {
      await migration.query('rollback').catch(() => undefined);
      await fast.close();
    }
    // Released, the same sign-in succeeds and reads the bundle as it is.
    expect((await staff.signIn()).session.authority.bundleRevision).toBe(1);
  });
});

describe('two writers in canonical order never deadlock (obligation 12, the writers)', () => {
  // Break caught: two release steps that each change a bundle and the Vendor policy, in the canonical order, waiting for each other.
  // The second holds its bundle while it waits for the policy the first holds; when the first commits, the second goes on.
  it('lets two steps that each take a bundle and then the Vendor policy complete, one after the other', async () => {
    const [x, y] = [await bundleOf([grant(READ_STAFF)]), await bundleOf([grant(READ_STAFF)])];
    const second = clientFor(database.urlFor(MIGRATION_ROLE));
    await second.connect();
    let following: Promise<unknown> | undefined;
    await migration.query('begin');
    try {
      await migration.query(`select melarc.lock_policy_keys($1::uuid[], $2::text[])`, [
        `{${x}}`,
        '{VENDOR}',
      ]);
      await migration.query(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'step-one')`,
        [x, grantsPayload([])],
      );
      await migration.query(`select melarc.change_fixed_policy('VENDOR', false, 'step-one')`);

      following = (async () => {
        await second.query('begin');
        await second.query(`select melarc.lock_policy_keys($1::uuid[], $2::text[])`, [
          `{${y}}`,
          '{VENDOR}',
        ]);
        await second.query(
          `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'step-two')`,
          [y, grantsPayload([])],
        );
        await second.query(`select melarc.change_fixed_policy('VENDOR', false, 'step-two')`);
        await second.query('commit');
      })();
      const blocked = await waitUntilBlocked(admin, database.name, /lock_policy_keys/);
      // It holds its own bundle and waits for the policy the first step holds: the shape of a deadlock if the order were not shared.
      const held = await advisoryOf(blocked.pid);
      expect(held.filter((lock) => lock.granted)).toEqual([
        { class: AUTH_POLICY_BUNDLE, key: bundleLockKey(y), mode: 'ExclusiveLock', granted: true },
      ]);

      await migration.query('commit');
      await following;

      expect(await bundleRow(x)).toMatchObject({ revision: 2, reduction_floor: 2 });
      expect(await bundleRow(y)).toMatchObject({ revision: 2, reduction_floor: 2 });
    } finally {
      await migration.query('rollback').catch(() => undefined);
      await following?.catch(() => undefined);
      await second.end();
    }
  });
});
