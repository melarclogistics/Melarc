import { Controller, Module, Post } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import { Anonymous } from '../../src/platform/routes/access-declaration.js';
import { clearIdentifierIn } from '../../src/test-support/clear-identifier.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { observe, type Observer } from './support/observe.js';
import { seedReferenceData } from './support/seeded.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.22 against a real PostgreSQL: an anonymous route that names a bucket reaches the **authoritative limiter first**, through the
 * runtime composition that binds it (no `ports` override: the application is wired as it ships), counts what a later slot refuses,
 * refuses the next request as `RATE_LIMITED` before any later slot, and stores no identifier. The effects are read from a second
 * connection. The limit is the seeded `rate_limit_staff_signin` (10 a minute), read from the settings by the limiter itself.
 */
let database: TestDatabase;
let reader: Observer;
let app: TestApp | undefined;
let handled = 0;

@Controller('guards')
class GuardsController {
  @Post('sign-in')
  @Anonymous({
    bucket: 'rate_limit_staff_signin',
    identifier: { field: 'email', maxBytes: 320 },
    canonical: (raw) => raw.trim().toLowerCase(),
  })
  signIn(): { handled: boolean } {
    handled += 1;
    return { handled: true };
  }
}

@Module({ controllers: [GuardsController] })
class GuardsModule {}

@Module({})
class Root {}

async function startOver(url: string): Promise<TestApp> {
  const loaded = loadConfig(validEnv({ DATABASE_URL: url, DATABASE_POOL_MAX: '3' }));
  if (!loaded.ok) throw new Error('the configuration was refused');
  return startTestApp({
    config: loaded.config,
    rootModule: (options) => {
      Module({ imports: [AppModule.register(options), GuardsModule] })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  reader = await observe(database);
  app = await startOver(database.urlFor(API_RUNTIME_ROLE));
});

afterAll(async () => {
  await app?.stop();
  await reader.close();
  await database.drop();
});

afterEach(() => {
  handled = 0;
});

const signIn = async (email: unknown): Promise<{ status: number; code: unknown }> => {
  if (app === undefined) throw new Error('the application is not running');
  const response = await fetch(`${app.baseUrl}/api/v1/guards/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = (await response.json()) as { code?: unknown };
  return { status: response.status, code: body.code };
};

const admissions = async (): Promise<number> =>
  (await reader.rows<{ n: number }>('select count(*)::int as n from rate_limit_admission'))[0]?.n ??
  0;

describe('an anonymous route that names a bucket, over the authoritative limiter', () => {
  // Break caught: the limiter consulted after the later slots, or not at all, or bound only in a test. Ten requests are counted even
  // though every one is then refused by the CSRF slot (not built yet), and the eleventh is refused by the limiter before it.
  it('counts each request a later slot refuses, and refuses the eleventh as RATE_LIMITED first', async () => {
    const email = 'ada@example.test';
    const before = await admissions();

    for (let index = 0; index < 10; index += 1) {
      expect(await signIn(email)).toEqual({ status: 403, code: 'CSRF_VALIDATION_FAILED' });
    }
    const eleventh = await signIn(email);

    expect(eleventh).toEqual({ status: 429, code: 'RATE_LIMITED' });
    expect((await admissions()) - before).toBe(10);
    expect(handled).toBe(0);
  });

  // Break caught: one caller's allowance spent by another's, or the same address written two ways counted twice.
  it('keeps an allowance of its own for another identifier, and counts the canonical form', async () => {
    expect(await signIn('grace@example.test')).toEqual({
      status: 403,
      code: 'CSRF_VALIDATION_FAILED',
    });
    const before = await admissions();

    await signIn('  GRACE@Example.Test ');

    expect((await admissions()) - before).toBe(1);
  });

  // Break caught (SECURITY_DESIGN.md §14.12): an identifier stored in clear, in any column of the limiter's table. The identifiers are
  // looked for as whole words (`clear-identifier.ts`): the row is mostly a random digest and a uuid, and a word made of the letters a to f,
  // "ada" here, turns up in one by chance, which failed the hosted run of 13 October 2026 with no identifier stored.
  it('stores a keyed digest and no identifier', async () => {
    await signIn('stored-check@example.test');

    const rows = await reader.rows<{ row: string }>(
      'select r::text as row from rate_limit_admission r',
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) {
      expect(
        clearIdentifierIn(row, ['example.test', 'ada', 'grace', 'stored-check']),
      ).toBeUndefined();
    }
  });

  // Break caught: a request without an identifier counted under some shared key, or refused for having none.
  it('does not count a request that carries no identifier it can take', async () => {
    const before = await admissions();

    for (const email of [undefined, '', 7, null]) {
      expect(await signIn(email)).toEqual({ status: 403, code: 'CSRF_VALIDATION_FAILED' });
    }

    expect(await admissions()).toBe(before);
  });
});

describe('a limiter whose store is unreachable', () => {
  let broken: TestApp | undefined;

  afterEach(async () => {
    await broken?.stop();
    broken = undefined;
  });

  // Break caught: a permissive fallback when the store is down, so that credential attempts go uncounted.
  it('refuses 503 with no code, and reaches no later slot or handler', async () => {
    // A server that does not answer on this port: the same login, nothing listening.
    broken = await startOver('postgres://melarc_api_runtime:unreachable@127.0.0.1:1/melarc_test');

    const response = await fetch(`${broken.baseUrl}/api/v1/guards/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.test' }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body.code).toBeUndefined();
    expect(response.headers.has('retry-after')).toBe(false);
    expect(handled).toBe(0);
  });
});
