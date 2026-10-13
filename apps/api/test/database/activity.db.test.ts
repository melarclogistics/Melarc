import { Body, Controller, Get, Inject, Module, Post, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { InMemoryRateLimiter } from '../../src/platform/limiter/in-memory.rate-limiter.adapter.js';
import { RATE_LIMIT_BUCKETS } from '../../src/platform/auth/ports/rate-limiter.port.js';
import { OPERATION_RUNNER } from '../../src/platform/authorization/authorization-providers.js';
import { authorizationOf } from '../../src/platform/authorization/authorized-request.js';
import type { OperationRunner } from '../../src/platform/authorization/operation-runner.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import {
  AUTH_POLICY_BUNDLE,
  bundleLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import { transactionOf } from '../../src/platform/database/transaction-handle.js';
import { ContractOperation } from '../../src/platform/contract/contract-operation.js';
import type { JsonObject } from '../../src/platform/contract/json.js';
import { ApiException } from '../../src/platform/http/api-exception.js';
import { ErrorCode } from '../../src/platform/http/error-codes.js';
import { RequiresPermission, Self } from '../../src/platform/routes/access-declaration.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { asBackground, EVERY_SURFACE, OPS_ONLY } from '../../src/test-support/route-options.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { traceStatements } from '../../src/test-support/work-shape.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery, type StaffPersona } from './support/personas.js';
import { applyContextFixture, applyFixture } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * Which requests are the person acting, and what a wait on a lock cannot do (S0.26; decision A of 12 October 2026; plan `OB-131`;
 * SECURITY_DESIGN.md section 13.3). Real HTTP over a real stack; the sessions are issued by the real protocol; **time is changed in
 * the data, and a lock is held and released by a latch the test watches, never by waiting a while**.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let observer: Observer;
let machinery: Machinery;
let app: TestApp;
let limited: TestApp;
const OPS = validEnv().OPS_ORIGIN ?? '';

const CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Activity fixture', version: '1' },
  paths: {
    '/activity/validated': {
      post: {
        operationId: 'activityValidated',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                additionalProperties: false,
                properties: { amount: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
} as unknown as JsonObject;

@Controller('activity')
class ActivityController {
  constructor(@Inject(OPERATION_RUNNER) private readonly runner: OperationRunner) {}

  @Get('qualifying')
  @Self(EVERY_SURFACE)
  qualifying(): { served: true } {
    return { served: true };
  }

  @Post('qualifying')
  @Self(EVERY_SURFACE)
  qualifyingWrite(): { served: true } {
    return { served: true };
  }

  @Get('background')
  @Self(asBackground(EVERY_SURFACE))
  background(): { served: true } {
    return { served: true };
  }

  @Get('denied')
  @RequiresPermission('staff.read', OPS_ONLY)
  denied(): { served: true } {
    return { served: true };
  }

  @Get('needs-p')
  @RequiresPermission('staff.session.revoke', { ...OPS_ONLY, tier: { minimum: 'P' } })
  needsP(): { served: true } {
    return { served: true };
  }

  @Get('conflict')
  @Self(EVERY_SURFACE)
  conflict(): never {
    throw ApiException.of(ErrorCode.StateConflict, 'The record changed');
  }

  @Get('missing')
  @Self(EVERY_SURFACE)
  missing(): never {
    throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
  }

  @Get('boom')
  @Self(EVERY_SURFACE)
  boom(): never {
    throw new Error('the platform failed');
  }

  @Post('validated')
  @Self(EVERY_SURFACE)
  @ContractOperation('activityValidated')
  validated(@Body() body: unknown): unknown {
    return body;
  }

  /** A state-changing request that writes a row of its own principal's, through the runner (the lock protocol). */
  @Post('mutate')
  @Self(EVERY_SURFACE)
  mutate(@Req() request: Request): Promise<{ written: number }> {
    const authorized = authorizationOf(request);
    if (authorized === undefined) throw new Error('no authorization decision');
    return this.runner.mutate(authorized, 'activity-test', async (handle) => {
      const result = await transactionOf(handle).execute(
        sql`insert into rls_fixture.owned_records (principal_type, principal_id, body)
            values ('STAFF', ${authorized.session.principalId}, 'written by the mutation') returning 1`,
      );
      return { written: result.rows.length };
    });
  }
}

@Module({ controllers: [ActivityController] })
class ActivityModule {}

async function start(options: { limit?: number } = {}): Promise<TestApp> {
  const loaded = loadConfig(
    validEnv({
      DATABASE_URL: database.urlFor(API_RUNTIME_ROLE),
      DATABASE_POOL_MAX: '4',
      ...(options.limit === undefined ? {} : { RATE_LIMITER: 'memory' }),
    }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  @Module({})
  class Root {}
  const clock = new ManualClock();
  return startTestApp({
    config: loaded.config,
    contractSource: { load: () => CONTRACT },
    rootModule: (moduleOptions) => {
      Module({
        imports: [
          AppModule.register({
            ...moduleOptions,
            ...(options.limit === undefined
              ? {}
              : {
                  ports: {
                    clock: { useValue: clock },
                    rateLimiter: {
                      useValue: new InMemoryRateLimiter({
                        clock,
                        limits: Object.fromEntries(
                          RATE_LIMIT_BUCKETS.map((bucket) => [bucket, options.limit]),
                        ) as never,
                      }),
                    },
                  },
                }),
          }),
          ActivityModule,
        ],
      })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await applyContextFixture(database);
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  observer = await observe(database);
  machinery = assemble(built);
  app = await start();
  limited = await start({ limit: 1 });
});

afterAll(async () => {
  await app.stop();
  await limited.stop();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

/** Lets `minutes` pass for a session, by changing the data. The guard trigger forbids it to the application and rightly. */
async function age(id: string, minutes: number): Promise<void> {
  await admin.query('alter table session disable trigger session_guard');
  try {
    await admin.query(
      `update session set issued_at = issued_at - make_interval(mins => $2),
                          last_activity_at = last_activity_at - make_interval(mins => $2),
                          expires_at = expires_at - make_interval(mins => $2) where id = $1`,
      [id, minutes],
    );
  } finally {
    await admin.query('alter table session enable trigger session_guard');
  }
}

const activityOf = async (id: string): Promise<number> =>
  (
    await observer.one<{ at: Date }>(`select last_activity_at as at from session where id = $1`, [
      id,
    ])
  )?.at.getTime() ?? 0;

const personaIdle = async (
  idleMinutes: number,
  bundle: string = BUNDLE_IDS.opsStaff,
): Promise<StaffPersona> => {
  const persona = await staffPersona(machinery, admin, { roleBundleId: bundle });
  await age(persona.issued.session.id, idleMinutes);
  return persona;
};

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  instance: TestApp,
  method: 'GET' | 'POST',
  path: string,
  persona: StaffPersona,
  options: { token?: boolean; body?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${instance.baseUrl}/api/v1/activity/${path}`, {
    method,
    headers: {
      cookie: persona.cookie,
      ...(method === 'POST'
        ? {
            'content-type': 'application/json',
            origin: OPS,
            ...(options.token === false ? {} : { 'x-csrf-token': persona.issued.csrfToken ?? '' }),
          }
        : {}),
    },
    ...(method === 'POST' ? { body: options.body ?? '{}' } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('a request that is the person acting extends the idle lifetime (decision A)', () => {
  // Break caught: activity not recorded, or recorded by the part that authenticates and so recorded for requests that are refused
  // afterwards. A qualifying request that passed every guard writes the activity, once, on the database's clock.
  it('records the activity of a qualifying request that passed every guard', async () => {
    const persona = await personaIdle(10);
    const before = await activityOf(persona.issued.session.id);

    const answer = await call(app, 'GET', 'qualifying', persona);

    expect(answer.status).toBe(200);
    expect(await activityOf(persona.issued.session.id)).toBeGreaterThan(before + 9 * 60_000);
  });

  it('records the activity of an unsafe request too, once the token and the Origin are right', async () => {
    const persona = await personaIdle(10);
    const before = await activityOf(persona.issued.session.id);

    expect((await call(app, 'POST', 'qualifying', persona)).status).toBe(201);

    expect(await activityOf(persona.issued.session.id)).toBeGreaterThan(before + 9 * 60_000);
  });

  // Break caught: a statement per request. The activity is covered for the window, so a burst writes nothing more.
  it('does not write when the recorded activity is younger than the coalescing window', async () => {
    const persona = await staffPersona(machinery, admin, { roleBundleId: BUNDLE_IDS.opsStaff });
    const before = await activityOf(persona.issued.session.id);

    const traced = await traceStatements(API_RUNTIME_ROLE, () =>
      call(app, 'GET', 'qualifying', persona),
    );

    expect(traced.result.status).toBe(200);
    expect(traced.statements.some((statement) => statement.startsWith('update session'))).toBe(
      false,
    );
    expect(await activityOf(persona.issued.session.id)).toBe(before);
  });

  // Break caught (decision A): "every 4xx is inactivity". The feedback on an authorized action is the person at the screen.
  it.each([
    ['a state conflict', 'conflict', 409],
    ['a record that is not there', 'missing', 404],
  ])('counts a request answered with %s', async (_label, path, status) => {
    const persona = await personaIdle(10);
    const before = await activityOf(persona.issued.session.id);

    expect((await call(app, 'GET', path, persona)).status).toBe(status);

    expect(await activityOf(persona.issued.session.id)).toBeGreaterThan(before + 9 * 60_000);
  });

  // Break caught: the interceptor inside the contract validation, which would never see its failure.
  it('counts a validation failure of an authorized action', async () => {
    const persona = await personaIdle(10);
    const before = await activityOf(persona.issued.session.id);

    const answer = await call(app, 'POST', 'validated', persona, { body: '{"amount":"many"}' });

    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe('VALIDATION_FAILED');
    expect(await activityOf(persona.issued.session.id)).toBeGreaterThan(before + 9 * 60_000);
  });
});

describe('what is refused for authority, or is not the person, does not extend it (decision A)', () => {
  // Break caught: a failed CSRF check extending the idle lifetime of the session it was refused on.
  it('does not count a failed CSRF check', async () => {
    const persona = await personaIdle(10);
    const before = await activityOf(persona.issued.session.id);

    const answer = await call(app, 'POST', 'qualifying', persona, { token: false });

    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('CSRF_VALIDATION_FAILED');
    expect(await activityOf(persona.issued.session.id)).toBe(before);
  });

  // Break caught: a denied authorization extending it.
  it('does not count a permission that is denied, or a tier that is too low', async () => {
    const opsStaff = await personaIdle(10, BUNDLE_IDS.opsStaff);
    const senior = await personaIdle(10, BUNDLE_IDS.seniorOps);
    const opsBefore = await activityOf(opsStaff.issued.session.id);
    const seniorBefore = await activityOf(senior.issued.session.id);

    const denied = await call(app, 'GET', 'denied', opsStaff);
    const tier = await call(app, 'GET', 'needs-p', senior);

    expect(denied.body.code).toBe('PERMISSION_DENIED');
    expect(tier.body.code).toBe('INSUFFICIENT_AUTHORITY');
    expect(await activityOf(opsStaff.issued.session.id)).toBe(opsBefore);
    expect(await activityOf(senior.issued.session.id)).toBe(seniorBefore);
  });

  // Break caught: a rate-limit refusal extending it, which would let a flood keep a session alive.
  it('does not count a request the rate limit refused', async () => {
    const persona = await personaIdle(10);
    expect((await call(limited, 'GET', 'background', persona)).status).toBe(200);
    const before = await activityOf(persona.issued.session.id);

    const refused = await call(limited, 'GET', 'qualifying', persona);

    expect(refused.status).toBe(429);
    expect(await activityOf(persona.issued.session.id)).toBe(before);
  });

  it('does not count a failure of the platform', async () => {
    const persona = await personaIdle(10);
    const before = await activityOf(persona.issued.session.id);

    expect((await call(app, 'GET', 'boom', persona)).status).toBe(500);

    expect(await activityOf(persona.issued.session.id)).toBe(before);
  });
});

describe('an unattended page that polls does not keep a session alive (decision A)', () => {
  // Break caught: a poll extending the idle lifetime, so a session left open in an unattended browser never ends. The polling
  // route is declared background; a session that only polls ends when its idle limit says so, polls and all.
  it('lets a session that only polls go idle, and keeps one whose person acts', async () => {
    const polling = await personaIdle(29);
    const acting = await personaIdle(29);

    expect((await call(app, 'GET', 'background', polling)).status).toBe(200);
    expect((await call(app, 'GET', 'qualifying', acting)).status).toBe(200);
    await age(polling.issued.session.id, 2);
    await age(acting.issued.session.id, 2);

    const idle = await call(app, 'GET', 'background', polling);
    const alive = await call(app, 'GET', 'background', acting);

    expect(idle.status).toBe(401);
    expect(idle.body.code).toBe('SESSION_INVALID');
    expect(alive.status).toBe(200);
  });

  // Break caught: nothing a client sends declaring the request to be a person: the policy is the route's.
  it('is not changed by anything the request says about itself', async () => {
    const persona = await personaIdle(10);
    const before = await activityOf(persona.issued.session.id);
    const response = await fetch(`${app.baseUrl}/api/v1/activity/background?user_activity=true`, {
      headers: {
        cookie: persona.cookie,
        'x-user-activity': 'true',
        'x-human': '1',
        'user-agent': 'Mozilla/5.0 (a person)',
      },
    });

    expect(response.status).toBe(200);
    expect(await activityOf(persona.issued.session.id)).toBe(before);
  });

  // Break caught: the absolute expiry moved by activity.
  it('does not move the absolute end of a session', async () => {
    const persona = await personaIdle(10);
    const row = await observer.one<{ expires_at: Date }>(
      `select expires_at from session where id = $1`,
      [persona.issued.session.id],
    );

    await call(app, 'GET', 'qualifying', persona);

    expect(
      (
        await observer.one<{ expires_at: Date }>(`select expires_at from session where id = $1`, [
          persona.issued.session.id,
        ])
      )?.expires_at,
    ).toEqual(row?.expires_at);
  });
});

describe('a wait on a lock cannot revive a session, and cannot authorize on stale authority (OB-131)', () => {
  /**
   * Waits until a statement of the application is blocked on a lock, by looking at the server and not at a clock: the statement
   * text begins as given and the server says it waits for a lock.
   */
  async function waitForBlocked(start: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // The server keeps the text as the driver sent it, with its leading white space.
      const waiting = await observer.rows(
        `select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and datname = current_database() and query ~* $1`,
        [`^\\s*${start.replaceAll(' ', '\\s+')}`],
      );
      if (waiting.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no statement beginning "${start}" was ever blocked on a lock`);
  }

  async function holder(): Promise<pg.Client> {
    const client = clientFor(database.urlFor('postgres'));
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  // Break caught: the activity written for a session that a revocation ended while the write waited for the row. The request is
  // served (it ordered itself before the revocation, which the specification allows); the ended session is not revived, and the
  // next request is refused.
  it('does not revive a session that is revoked while the activity write waits for its row', async () => {
    const persona = await personaIdle(10);
    const id = persona.issued.session.id;
    const before = await activityOf(id);
    const revoker = await holder();
    try {
      await revoker.query('begin');
      await revoker.query('select 1 from session where id = $1 for update', [id]);

      const pending = call(app, 'GET', 'qualifying', persona);
      await waitForBlocked('select 1 from session where id');
      await revoker.query(
        `update session set terminated_at = clock_timestamp(), termination_reason = 'ADMIN_REVOKED' where id = $1`,
        [id],
      );
      await revoker.query('commit');

      expect((await pending).status).toBe(200);
    } finally {
      await revoker.end();
    }

    expect(await activityOf(id)).toBe(before);
    expect(
      (
        await observer.one<{ termination_reason: string }>(
          `select termination_reason from session where id = $1`,
          [id],
        )
      )?.termination_reason,
    ).toBe('ADMIN_REVOKED');
    expect((await call(app, 'GET', 'qualifying', persona)).status).toBe(401);
  });

  // Break caught: the activity written for a session that went idle while the write waited, judged on the time of the earlier
  // read and not on a fresh one after the wait.
  it('does not extend a session that goes idle while the activity write waits for its row', async () => {
    const persona = await personaIdle(10);
    const id = persona.issued.session.id;
    const before = await activityOf(id);
    const ager = await holder();
    await admin.query('alter table session disable trigger session_guard');
    try {
      await ager.query('begin');
      await ager.query('select 1 from session where id = $1 for update', [id]);

      const pending = call(app, 'GET', 'qualifying', persona);
      await waitForBlocked('select 1 from session where id');
      // Twenty-one more minutes pass for the session while the request waits: thirty-one in all, which is idle.
      await ager.query(
        `update session set issued_at = issued_at - interval '21 minutes',
                            last_activity_at = last_activity_at - interval '21 minutes',
                            expires_at = expires_at - interval '21 minutes' where id = $1`,
        [id],
      );
      await ager.query('commit');

      expect((await pending).status).toBe(200);
    } finally {
      await ager.end();
      await admin.query('alter table session enable trigger session_guard');
    }

    expect(await activityOf(id)).toBe(before - 21 * 60_000);
    expect((await call(app, 'GET', 'qualifying', persona)).status).toBe(401);
  });

  // Break caught (GBT-B12, section 13.10a obligation 3): a mutation authorized by the session as it was before a reduction that
  // ended it, while the mutation waited for the lock the reduction held. It waits behind the exclusive lock, finds the session
  // ended when it has the shared one, and writes nothing.
  it('refuses a mutation whose session a reduction ended while the mutation waited for the policy lock, and writes nothing', async () => {
    const persona = await personaIdle(1);
    const id = persona.issued.session.id;
    const bundleKey = bundleLockKey(BUNDLE_IDS.opsStaff);
    const reducer = await holder();
    try {
      await reducer.query('begin');
      await reducer.query('select pg_advisory_xact_lock($1::int4, $2::int4)', [
        AUTH_POLICY_BUNDLE,
        bundleKey,
      ]);

      const pending = call(app, 'POST', 'mutate', persona);
      await waitForBlocked('select pg_advisory_xact_lock_shared');
      // The reduction ends the sessions of the bundle in the same transaction that holds the lock, as the primitive does.
      await reducer.query(
        `update session set terminated_at = clock_timestamp(), termination_reason = 'AUTHORITY_CHANGED' where id = $1`,
        [id],
      );
      await reducer.query('commit');

      const answer = await pending;
      expect(answer.status).toBe(401);
      expect(answer.body.code).toBe('SESSION_INVALID');
    } finally {
      await reducer.end();
    }

    const written = await observer.rows(
      `select 1 from rls_fixture.owned_records where principal_id = $1`,
      [persona.identity.id],
    );
    expect(written).toEqual([]);
  });

  // Break caught: a mutation authorized on a session that went idle while it waited for the policy lock: the standing is judged on
  // one fresh instant read after the locks, not on the time of the authentication that preceded the wait.
  it('refuses a mutation whose session went idle while it waited for the policy lock', async () => {
    const persona = await personaIdle(10);
    const id = persona.issued.session.id;
    const holderClient = await holder();
    await admin.query('alter table session disable trigger session_guard');
    try {
      await holderClient.query('begin');
      await holderClient.query('select pg_advisory_xact_lock($1::int4, $2::int4)', [
        AUTH_POLICY_BUNDLE,
        bundleLockKey(BUNDLE_IDS.opsStaff),
      ]);

      const pending = call(app, 'POST', 'mutate', persona);
      await waitForBlocked('select pg_advisory_xact_lock_shared');
      await holderClient.query(
        `update session set issued_at = issued_at - interval '21 minutes',
                            last_activity_at = last_activity_at - interval '21 minutes',
                            expires_at = expires_at - interval '21 minutes' where id = $1`,
        [id],
      );
      await holderClient.query('commit');

      const answer = await pending;
      expect(answer.status).toBe(401);
      expect(answer.body.code).toBe('SESSION_INVALID');
    } finally {
      await holderClient.end();
      await admin.query('alter table session enable trigger session_guard');
    }

    expect(
      await observer.rows(`select 1 from rls_fixture.owned_records where principal_id = $1`, [
        persona.identity.id,
      ]),
    ).toEqual([]);
  });

  // Control: the same mutation, with nothing holding the lock, is served and writes its row.
  it('serves the same mutation when nothing intervenes, and writes under the context of its principal', async () => {
    const persona = await personaIdle(1);

    const answer = await call(app, 'POST', 'mutate', persona);

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ written: 1 });
    expect(
      await observer.rows(`select 1 from rls_fixture.owned_records where principal_id = $1`, [
        persona.identity.id,
      ]),
    ).toHaveLength(1);
  });
});
