import { randomUUID } from 'node:crypto';

import { Controller, Get, Module, Post } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import {
  Anonymous,
  RequiresPermission,
  Self,
} from '../../src/platform/routes/access-declaration.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { RawClient } from '../../src/test-support/raw-http.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  OPS_STAFF_SNAPSHOT,
  insertSessionRow,
  sessionRow,
  type SessionRow,
} from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.24 over real HTTP and the real stack: the authentication guard as the application ships it, on a database. A session the
 * issue protocol issued is accepted from its cookie, and what follows is the next slot of the chain refusing (CSRF for an unsafe
 * method, authorization for the rest), because neither is built yet and neither serves a route that needs a principal; a request
 * with no usable session is `401`, and all of them answer the same; the authenticated bucket counts the session it found.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let observer: Observer;
let machinery: Machinery;
let app: TestApp;
let handled = 0;

@Controller('guarded')
class GuardedController {
  @Get('self')
  @Self()
  self(): { handled: boolean } {
    handled += 1;
    return { handled: true };
  }

  @Post('self')
  @Self()
  selfWrite(): { handled: boolean } {
    handled += 1;
    return { handled: true };
  }

  @Get('permission')
  @RequiresPermission('staff.read')
  permission(): { handled: boolean } {
    handled += 1;
    return { handled: true };
  }

  @Get('open')
  @Anonymous()
  open(): { handled: boolean } {
    handled += 1;
    return { handled: true };
  }
}

@Module({ controllers: [GuardedController] })
class GuardedModule {}

@Module({})
class Root {}

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  observer = await observe(database);
  machinery = assemble(built);
  const loaded = loadConfig(
    validEnv({ DATABASE_URL: database.urlFor(API_RUNTIME_ROLE), DATABASE_POOL_MAX: '3' }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  app = await startTestApp({
    config: loaded.config,
    rootModule: (options) => {
      Module({ imports: [AppModule.register(options), GuardedModule] })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
});

afterAll(async () => {
  await app.stop();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  handled = 0;
  const response = await fetch(`${app.baseUrl}/api/v1/guarded/${path}`, {
    method,
    headers: { ...headers, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  };
}

const arranged = async (overrides: Partial<SessionRow>): Promise<string> => {
  const issued = machinery.tokens.issue();
  await insertSessionRow(admin, sessionRow({ tokenHash: Buffer.from(issued.hash), ...overrides }));
  return issued.token;
};
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

describe('a request with no usable session', () => {
  // Break caught (AC-SLICE-000-44): a missing session answered 403, or served; and the answers differing in a way that tells a
  // caller which guess was closest.
  it.each([
    ['no credential', () => Promise.resolve<Record<string, string>>({})],
    [
      'a token nobody holds',
      () => Promise.resolve({ cookie: `melarc_session=${machinery.tokens.issue().token}` }),
    ],
    [
      'something that is not a token',
      () => Promise.resolve({ cookie: 'melarc_session=not-a-token' }),
    ],
    [
      'a cookie and a bearer credential together',
      async () => {
        const persona = await staffPersona(machinery, admin);
        return { cookie: persona.cookie, authorization: `Bearer ${persona.issued.token}` };
      },
    ],
    [
      'a session token presented the wrong way',
      async () => ({
        authorization: `Bearer ${(await staffPersona(machinery, admin)).issued.token}`,
      }),
    ],
    [
      'an ended session',
      async () => {
        const persona = await staffPersona(machinery, admin);
        await admin.query(
          `update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where id = $1`,
          [persona.issued.session.id],
        );
        return { cookie: persona.cookie };
      },
    ],
    [
      'a session past its absolute end',
      async () => ({
        cookie: `melarc_session=${await arranged({ issuedAt: minutesAgo(800), expiresAt: minutesAgo(1), lastActivityAt: minutesAgo(2) })}`,
      }),
    ],
    [
      'a session idle past its limit',
      async () => ({
        cookie: `melarc_session=${await arranged({ issuedAt: minutesAgo(100), lastActivityAt: minutesAgo(31) })}`,
      }),
    ],
  ])('is refused 401 SESSION_INVALID, the same way, for %s', async (_label, headers) => {
    for (const [method, path] of [
      ['GET', 'self'],
      ['POST', 'self'],
      ['GET', 'permission'],
    ] as const) {
      const answer = await call(method, path, await headers());

      expect(answer.status).toBe(401);
      expect(answer.body).toMatchObject({ code: 'SESSION_INVALID', message: 'No usable session' });
      expect(Object.keys(answer.body).toSorted()).toEqual(['code', 'message', 'request_id']);
      expect(answer.headers.get('set-cookie')).toBeNull();
      expect(handled).toBe(0);
    }
  });

  // Break caught (errors-and-enums.md §4): a displaced vendor told the same as everyone, so that a colleague's sign-in looks like an
  // expiry; and a staff session ended by a supersession (which cannot happen) told it was superseded.
  it('tells a displaced vendor session it was superseded, and nobody else', async () => {
    const vendor = await arranged({
      principalType: 'VENDOR',
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: BUNDLE_IDS.vendor,
      snapshot: { ...OPS_STAFF_SNAPSHOT, name: 'Vendor', audience: 'VENDOR' },
      terminatedAt: new Date(),
      terminationReason: 'SUPERSEDED_BY_NEW_LOGIN',
    });
    const staff = await arranged({
      terminatedAt: new Date(),
      terminationReason: 'SUPERSEDED_BY_NEW_LOGIN',
    });

    const displaced = await call('GET', 'self', { cookie: `melarc_session=${vendor}` });
    const other = await call('GET', 'self', { cookie: `melarc_session=${staff}` });

    expect(displaced.status).toBe(401);
    expect(displaced.body).toMatchObject({ code: 'SESSION_SUPERSEDED' });
    expect(other.body).toMatchObject({ code: 'SESSION_INVALID' });
  });

  // Break caught: a pre-authentication route made to depend on a session, so that a browser holding a stale cookie cannot sign in.
  it('does not stop an anonymous route, whatever cookie it carries', async () => {
    const answer = await call('GET', 'open', { cookie: 'melarc_session=garbage' });

    expect(answer.status).toBe(200);
    expect(handled).toBe(1);
  });
});

describe('two credentials in one request', () => {
  // Break caught (found by the review of this batch): two Authorization header lines resolved to the first, because Node keeps only the
  // first of a duplicated Authorization header in `headers`. The request is sent as bytes, since `fetch` cannot send the header twice.
  // The credential is a live rider session, so that the one refusal in play is the ambiguity.
  it('refuses a request with two Authorization header lines though the first is a live session, and accepts it with one', async () => {
    const token = await arranged({
      principalType: 'RIDER',
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: BUNDLE_IDS.rider,
      snapshot: { ...OPS_STAFF_SNAPSHOT, name: 'Rider', audience: 'RIDER' },
    });
    const send = async (authorizations: readonly string[]) => {
      const client = await RawClient.connect(app.baseUrl);
      try {
        await client.write(
          `GET /api/v1/guarded/self HTTP/1.1\r\nHost: 127.0.0.1\r\n${authorizations
            .map((value) => `Authorization: ${value}\r\n`)
            .join('')}Connection: close\r\n\r\n`,
        );
        return await client.read();
      } finally {
        client.destroy();
      }
    };
    handled = 0;

    const one = await send([`Bearer ${token}`]);
    const two = await send([`Bearer ${token}`, `Bearer ${token}`]);

    // One credential authenticates, and the next slot (authorization, not built) refuses; two are refused at authentication.
    expect(one.status).toBe(403);
    expect(one.json).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(two.status).toBe(401);
    expect(two.json).toMatchObject({ code: 'SESSION_INVALID' });
    expect(handled).toBe(0);
  });
});

describe('a live session', () => {
  // Break caught: an authenticated session served by a slot that is not built. Authentication passes, and the next slot refuses
  // (authorization: PERMISSION_DENIED; for an unsafe method CSRF comes first), and the handler is never reached.
  it('passes authentication and is refused by the slot after it, and the handler is not reached', async () => {
    const persona = await staffPersona(machinery, admin);

    const read = await call('GET', 'self', { cookie: persona.cookie });
    const permission = await call('GET', 'permission', { cookie: persona.cookie });
    const write = await call('POST', 'self', { cookie: persona.cookie });

    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(permission.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'CSRF_VALIDATION_FAILED' });
    expect(handled).toBe(0);
  });

  // Break caught: the authenticated bucket not counting the session that was found, or counting an invented key.
  it('counts each accepted request in the authenticated-API bucket, keyed by the session', async () => {
    const persona = await staffPersona(machinery, admin);
    const before = await observer.count('rate_limit_admission', {
      bucket: 'rate_limit_authenticated_api',
    });

    await call('GET', 'self', { cookie: persona.cookie });
    await call('GET', 'self', { cookie: persona.cookie });
    await call('GET', 'self', { cookie: `melarc_session=${machinery.tokens.issue().token}` });
    await call('GET', 'self');

    // Two accepted requests were counted; the unknown token and the request with no credential were refused before the bucket.
    expect(
      (await observer.count('rate_limit_admission', { bucket: 'rate_limit_authenticated_api' })) -
        before,
    ).toBe(2);
  });

  it('refuses 429 RATE_LIMITED once the bucket is spent, with no Retry-After and nothing served', async () => {
    const persona = await staffPersona(machinery, admin);
    const limit = Number(
      (
        await observer.one<{ value: number }>(
          `select value from setting where key = 'rate_limit_authenticated_api'`,
        )
      )?.value,
    );

    for (let index = 0; index < limit; index += 1) {
      expect((await call('GET', 'self', { cookie: persona.cookie })).status).toBe(403);
    }
    const spent = await call('GET', 'self', { cookie: persona.cookie });

    expect(limit).toBe(120);
    expect(spent.status).toBe(429);
    expect(spent.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(spent.headers.get('retry-after')).toBeNull();
    expect(handled).toBe(0);
  }, 60_000);

  // Break caught: activity not recorded, so that a session in use would be ended as idle; recorded too often, a write per request.
  it('records the activity of an accepted request once its recorded activity is old enough', async () => {
    const token = await arranged({ issuedAt: minutesAgo(10), lastActivityAt: minutesAgo(5) });
    const id = (
      await observer.one<{ id: string }>(`select id from session where token_hash = $1`, [
        machinery.tokens.hash(token),
      ])
    )?.id;

    await call('GET', 'self', { cookie: `melarc_session=${token}` });
    const first = (
      await observer.one<{ last_activity_at: Date }>(
        `select last_activity_at from session where id = $1`,
        [id],
      )
    )?.last_activity_at;
    await call('GET', 'self', { cookie: `melarc_session=${token}` });
    const second = (
      await observer.one<{ last_activity_at: Date }>(
        `select last_activity_at from session where id = $1`,
        [id],
      )
    )?.last_activity_at;

    expect(Math.abs((first?.getTime() ?? 0) - Date.now())).toBeLessThan(10_000);
    expect(second).toEqual(first);
  });
});
