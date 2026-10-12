import 'reflect-metadata';

import {
  Controller,
  Delete,
  Get,
  Module,
  Patch,
  Post,
  Put,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { InMemoryRateLimiter } from '../limiter/in-memory.rate-limiter.adapter.js';
import { LimiterUnavailableError } from '../limiter/limiter-errors.js';
import { RATE_LIMIT_BUCKETS, type RateLimiter } from '../auth/ports/rate-limiter.port.js';
import { ManualClock } from '../../test-support/manual-clock.js';
import { startTestApp, TEST_CONFIG, type TestApp } from '../../test-support/test-app.js';
import { PlatformModule } from '../platform.module.js';
import type { AppConfig } from '../config/load-config.js';
import { ApiException } from '../http/api-exception.js';
import {
  ACCESS_DECLARATION_KEY,
  Anonymous,
  RequiresPermission,
  Self,
  TechnicalEndpoint,
  type AnonymousLimit,
} from './access-declaration.js';
import { AuthenticationGuard } from './authentication.guard.js';
import { AuthorizationGuard } from './authorization.guard.js';
import { CsrfGuard } from './csrf.guard.js';
import { DenyByDefaultGuard } from './deny-by-default.guard.js';
import { GUARD_CHAIN } from './guard-chain.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { inspectRoutes } from './route-inventory.js';

/**
 * The guard chain over real HTTP (S0.22). The order is the refusal order of permission-enforcement.md §5.1, built once and
 * proved on fixture routes: **declaration, rate limit, authentication, CSRF and Origin, then (S0.26) authorization**. The
 * slots after the limiter exist and **fail closed** until their own tasks replace them (S0.24 authentication, S0.25 CSRF, S0.26
 * authorization), so a route that is declared but whose guard is not built is refused, never served.
 */

const LIMIT_PER_MINUTE = 2;
const EMAIL_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_staff_signin',
  identifier: { field: 'email', maxBytes: 64 },
  canonical: (raw) => raw.trim().toLowerCase(),
};

/** A second bucket, so that a guard that asks the limiter for some other bucket than the route names is seen. */
const RECOVERY_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_recovery',
  identifier: { field: 'grant', maxBytes: 64 },
  canonical: (raw) => raw,
};

let handled = 0;

/** What the limiter was asked, in order, by a limiter that admits everything. */
const asked: { bucket: string; key: string }[] = [];
const recording: RateLimiter = {
  admit: (bucket, key) => {
    asked.push({ bucket, key });
    return Promise.resolve({ allowed: true });
  },
};

@Controller('access')
class AccessController {
  @Get('undeclared')
  undeclared(): { label: string } {
    handled += 1;
    return { label: 'undeclared' };
  }

  @Get('technical')
  @TechnicalEndpoint()
  technical(): { label: string } {
    handled += 1;
    return { label: 'technical' };
  }

  @Get('open')
  @Anonymous()
  open(): { label: string } {
    handled += 1;
    return { label: 'open' };
  }

  @Post('open')
  @Anonymous()
  openWrite(): { label: string } {
    handled += 1;
    return { label: 'open' };
  }

  @Post('limited')
  @Anonymous(EMAIL_LIMIT)
  limited(): { label: string } {
    handled += 1;
    return { label: 'limited' };
  }

  @Post('recovery')
  @Anonymous(RECOVERY_LIMIT)
  recovery(): { label: string } {
    handled += 1;
    return { label: 'recovery' };
  }

  @Post('technical')
  @TechnicalEndpoint()
  technicalWrite(): { label: string } {
    handled += 1;
    return { label: 'technical' };
  }

  @Put('open')
  @Anonymous()
  openPut(): { label: string } {
    handled += 1;
    return { label: 'open' };
  }

  @Patch('open')
  @Anonymous()
  openPatch(): { label: string } {
    handled += 1;
    return { label: 'open' };
  }

  @Delete('open')
  @Anonymous()
  openDelete(): { label: string } {
    handled += 1;
    return { label: 'open' };
  }

  @Get('self')
  @Self()
  self(): { label: string } {
    handled += 1;
    return { label: 'self' };
  }

  @Post('self')
  @Self()
  selfWrite(): { label: string } {
    handled += 1;
    return { label: 'self' };
  }

  @Get('permission')
  @RequiresPermission('staff.read')
  permission(): { label: string } {
    handled += 1;
    return { label: 'permission' };
  }
}

@Module({ controllers: [AccessController] })
class AccessModule {}

@Module({})
class Root {}

let running: TestApp | undefined;
let clock = new ManualClock();

const LIMITS = Object.fromEntries(RATE_LIMIT_BUCKETS.map((bucket) => [bucket, LIMIT_PER_MINUTE]));

function runtimeConfig(): AppConfig {
  return {
    ...TEST_CONFIG,
    composition: 'runtime',
    adapters: { ...TEST_CONFIG.adapters, limiter: 'memory' },
  };
}

async function start(limiter?: RateLimiter | null): Promise<TestApp> {
  handled = 0;
  asked.length = 0;
  clock = new ManualClock();
  const bound =
    limiter === undefined ? new InMemoryRateLimiter({ clock, limits: LIMITS as never }) : limiter;
  running = await startTestApp({
    config: runtimeConfig(),
    rootModule: (options) => {
      Module({
        imports: [
          AppModule.register({
            ...options,
            ports: {
              clock: { useValue: clock },
              ...(bound === null ? {} : { rateLimiter: { useValue: bound } }),
            },
          }),
          AccessModule,
        ],
      })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfter: string | null;
}

async function call(app: TestApp, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${app.baseUrl}/api/v1/access/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    retryAfter: response.headers.get('retry-after'),
  };
}

const codeOf = (answer: Answer): unknown => answer.body.code;

describe('a route that declares nothing (AC-SLICE-000-25)', () => {
  // Break caught: a route with no declaration served because the framework permits by default.
  it('is refused with PERMISSION_DENIED, and its handler is never reached', async () => {
    const app = await start();

    const answer = await call(app, 'GET', 'undeclared');

    expect(answer.status).toBe(403);
    expect(codeOf(answer)).toBe('PERMISSION_DENIED');
    expect(handled).toBe(0);
  });
});

describe('the four declarations, and what the chain does with each', () => {
  // Break caught: a probe made to pass through checks it has no business with.
  it('lets a technical route through every slot', async () => {
    const app = await start();

    const answer = await call(app, 'GET', 'technical');

    expect(answer.status).toBe(200);
    expect(handled).toBe(1);
  });

  it('lets an anonymous read through, and has no limiter to consult when the route names none', async () => {
    const app = await start();

    for (let index = 0; index < 5; index += 1) {
      expect((await call(app, 'GET', 'open')).status).toBe(200);
    }
  });

  // Break caught (AC-SLICE-000-44): a missing session answered 403, which would tell a client that it is signed in and not allowed.
  // A request that carries no usable session is 401 SESSION_INVALID on every route that needs one, and authorization never
  // answers it.
  it.each([
    ['self', 'GET', 'self'],
    ['self, a write', 'POST', 'self'],
    ['permission', 'GET', 'permission'],
  ])(
    'refuses a %s route with 401 SESSION_INVALID while no session can exist',
    async (_label, method, path) => {
      const app = await start();

      const answer = await call(app, method, path, method === 'POST' ? {} : undefined);

      expect(answer.status).toBe(401);
      expect(codeOf(answer)).toBe('SESSION_INVALID');
      expect(handled).toBe(0);
    },
  );

  // Break caught: the CSRF and Origin step missing, so that the first state-changing anonymous operation is open to a cross-site
  // form. Until S0.25 builds it, the slot refuses every unsafe request that reaches it.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses an unsafe anonymous %s with 403 CSRF_VALIDATION_FAILED until the CSRF slot is built',
    async (method) => {
      const app = await start();

      const answer = await call(app, method, 'open', {});

      expect(answer.status).toBe(403);
      expect(codeOf(answer)).toBe('CSRF_VALIDATION_FAILED');
      expect(handled).toBe(0);
    },
  );

  // Break caught: a probe made subject to the CSRF slot. A technical route is not a browser surface and not a contract operation.
  it('does not hold a technical route to the CSRF slot, whatever its method', async () => {
    const app = await start();

    const answer = await call(app, 'POST', 'technical', {});

    expect(answer.status).toBe(201);
    expect(handled).toBe(1);
  });
});

describe('the authorization slot, reached directly (it fails closed until S0.26)', () => {
  const context = (declaration: string | undefined): ExecutionContext => {
    const controller = (): void => undefined;
    const handler = (): void => undefined;
    if (declaration !== undefined)
      Reflect.defineMetadata(ACCESS_DECLARATION_KEY, declaration, handler);
    return {
      getHandler: () => handler,
      getClass: () => controller,
    } as unknown as ExecutionContext;
  };
  const guard = new AuthorizationGuard(new Reflector());

  // Break caught: a route that needs a principal served by the slot that is meant to refuse it. Authentication refuses first on a
  // real request, so no request reaches this slot until a session can exist; the slot is held to its own rule here and again, with a
  // session, in the sessions test.
  it.each(['self', 'permission'])(
    'refuses a %s route with 403 PERMISSION_DENIED',
    (declaration) => {
      let refusal: unknown;
      try {
        guard.canActivate(context(declaration));
      } catch (error) {
        refusal = error;
      }

      expect(refusal).toBeInstanceOf(ApiException);
      expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect((refusal as ApiException).getStatus()).toBe(403);
    },
  );

  it.each(['anonymous', 'technical'])('has nothing to refuse on a %s route', (declaration) => {
    expect(guard.canActivate(context(declaration))).toBe(true);
  });
});

describe('the rate limit comes first (AC-SLICE-000-130, step 1)', () => {
  // Break caught: the limiter consulted after the later steps, or not at all: the request would be refused for its Origin first,
  // however often it is repeated, and nothing would ever count it.
  it('counts a request that a later slot refuses, and refuses the next ones as RATE_LIMITED before any later slot', async () => {
    const app = await start();
    const email = { email: 'ada@example.test' };

    const first = await call(app, 'POST', 'limited', email);
    const second = await call(app, 'POST', 'limited', email);
    const third = await call(app, 'POST', 'limited', email);

    expect([first.status, second.status]).toEqual([403, 403]);
    expect([codeOf(first), codeOf(second)]).toEqual([
      'CSRF_VALIDATION_FAILED',
      'CSRF_VALIDATION_FAILED',
    ]);
    expect(third.status).toBe(429);
    expect(codeOf(third)).toBe('RATE_LIMITED');
    expect(handled).toBe(0);
  });

  // Break caught: the limiter asked about some other bucket than the one the route names (a sign-in counted against the recovery
  // allowance, say), or about the identifier as typed and not in its canonical form.
  it('asks the limiter for the bucket the route names, with the key in its canonical form', async () => {
    const app = await start(recording);

    await call(app, 'POST', 'limited', { email: '  ADA@Example.Test ' });
    await call(app, 'POST', 'recovery', { grant: 'GrantValue' });

    expect(asked).toEqual([
      { bucket: 'rate_limit_staff_signin', key: 'ada@example.test' },
      { bucket: 'rate_limit_recovery', key: 'GrantValue' },
    ]);
  });

  // Break caught (errors-and-enums.md §4): a Retry-After on a 429, which tells an attacker how long to wait.
  it('answers 429 with no Retry-After', async () => {
    const app = await start();
    for (let index = 0; index < LIMIT_PER_MINUTE; index += 1) {
      await call(app, 'POST', 'limited', { email: 'ada@example.test' });
    }

    const refused = await call(app, 'POST', 'limited', { email: 'ada@example.test' });

    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBeNull();
    expect(Object.keys(refused.body).toSorted()).toEqual(['code', 'message', 'request_id']);
  });

  // Break caught: one caller's allowance spent by another's key, or the same identifier written two ways counted as two.
  it('keeps a key of its own for each identifier, in its canonical form', async () => {
    const app = await start();

    await call(app, 'POST', 'limited', { email: 'ada@example.test' });
    await call(app, 'POST', 'limited', { email: '  ADA@Example.Test ' });
    const sameAgain = await call(app, 'POST', 'limited', { email: 'ada@example.test' });
    const other = await call(app, 'POST', 'limited', { email: 'grace@example.test' });

    expect(sameAgain.status).toBe(429);
    expect(other.status).toBe(403);
  });

  // Break caught: the allowance returning only because the test waited, or never returning: the window rolls on the limiter's clock.
  it('admits again once the window has passed', async () => {
    const app = await start();
    for (let index = 0; index < LIMIT_PER_MINUTE; index += 1) {
      await call(app, 'POST', 'limited', { email: 'ada@example.test' });
    }
    expect((await call(app, 'POST', 'limited', { email: 'ada@example.test' })).status).toBe(429);

    clock.advance(61_000);

    expect((await call(app, 'POST', 'limited', { email: 'ada@example.test' })).status).toBe(403);
  });

  // Break caught: an identifier that cannot be taken being refused for it, or being counted under some other key. Without one the
  // request meets the coarse admission limits of the transport and nothing else (permission-enforcement.md §5.1).
  it.each([
    ['no body', undefined],
    ['a body that is not an object', ['ada@example.test']],
    ['an identifier of the wrong type', { email: 7 }],
    ['an empty identifier', { email: '' }],
    ['an identifier over its bound', { email: `${'a'.repeat(64)}@example.test` }],
  ])('does not count a request with %s, and does not refuse it for that', async (_label, body) => {
    const app = await start();

    for (let index = 0; index < 5; index += 1) {
      const answer = await call(app, 'POST', 'limited', body);
      expect(answer.status).toBe(403);
      expect(codeOf(answer)).toBe('CSRF_VALIDATION_FAILED');
    }
  });

  // Break caught: a body that cannot be read meeting the limiter with an identifier it never had.
  it('does not take an identifier from a body that is not valid JSON', async () => {
    const app = await start();

    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${app.baseUrl}/api/v1/access/limited`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email": "ada@example.test"',
      });
      expect(response.status).toBe(403);
      await response.text();
    }
  });
});

describe('a limiter that cannot decide fails closed', () => {
  const unavailable: RateLimiter = {
    admit: () => Promise.reject(new LimiterUnavailableError()),
  };

  // Break caught (SECURITY_DESIGN.md §14.12): a permissive fallback when the store is down.
  it('answers 503 with no code and no retry hint, and reaches nothing after it', async () => {
    const app = await start(unavailable);

    const answer = await call(app, 'POST', 'limited', { email: 'ada@example.test' });

    expect(answer.status).toBe(503);
    expect(answer.body.code).toBeUndefined();
    expect(answer.retryAfter).toBeNull();
    expect(handled).toBe(0);
  });

  // Break caught: a route that names a bucket served when no limiter was composed, which is the same permissive fallback.
  it('answers 503 when no limiter is composed at all, for a route that names a bucket', async () => {
    const app = await start(null);

    const answer = await call(app, 'POST', 'limited', { email: 'ada@example.test' });

    expect(answer.status).toBe(503);
    expect(handled).toBe(0);
  });

  it('does not need a limiter for a route that names no bucket', async () => {
    const app = await start(null);

    expect((await call(app, 'GET', 'open')).status).toBe(200);
  });
});

describe('the route inventory knows the kind of every route (AC-SLICE-000-25)', () => {
  // Break caught: a route whose declaration the inventory cannot see, or an undeclared one it does not list. The test enumerates
  // every live route and fails if one lacks a declaration, which is the mechanical half of the deny-by-default rule.
  it('enumerates every live route with its kind, its permission key and its bucket, and names the undeclared one', async () => {
    const app = await start();
    const inspection = inspectRoutes(app.app);

    const access = (method: string, path: string) =>
      inspection.declared.find((route) => route.method === method && route.path === path);
    expect(access('GET', '/api/v1/access/technical')?.access).toBe('technical');
    expect(access('GET', '/api/v1/access/open')?.access).toBe('anonymous');
    expect(access('POST', '/api/v1/access/limited')).toMatchObject({
      access: 'anonymous',
      bucket: 'rate_limit_staff_signin',
    });
    expect(access('GET', '/api/v1/access/self')?.access).toBe('self');
    expect(access('GET', '/api/v1/access/permission')).toMatchObject({
      access: 'permission',
      permission: 'staff.read',
    });
    expect(inspection.undeclared).toEqual([{ method: 'GET', path: '/api/v1/access/undeclared' }]);
    expect(inspection.outsideNest).toEqual([]);
    expect(inspection.missingFromRouter).toEqual([]);
  });

  // Break caught: an application with an undeclared route starting, so that its refusal is found by a user and not at start.
  it('stops the application at start when a route declares nothing', async () => {
    await expect(
      startTestApp({
        config: runtimeConfig(),
        rootModule: (options) => {
          Module({ imports: [AppModule.register(options), AccessModule] })(Root);
          return Root;
        },
      }),
    ).rejects.toThrow(/declare/i);
  });
});

describe('the chain itself', () => {
  // Break caught: the refusal order changed by reordering a list, which no behaviour test of a single route would show.
  it('is declaration, rate limit, authentication, CSRF and Origin, authorization, in that order', () => {
    expect(GUARD_CHAIN).toEqual([
      DenyByDefaultGuard,
      RateLimitGuard,
      AuthenticationGuard,
      CsrfGuard,
      AuthorizationGuard,
    ]);
  });

  it('is what the platform registers as global guards, in that order, and nothing else', () => {
    const module = PlatformModule.register({
      config: TEST_CONFIG,
      logger: { child: () => undefined } as never,
    });
    const registered = ((module.providers ?? []) as { provide?: unknown; useClass?: unknown }[])
      .filter((provider) => provider.provide === APP_GUARD)
      .map((provider) => provider.useClass);

    expect(registered).toEqual([...GUARD_CHAIN]);
  });
});
