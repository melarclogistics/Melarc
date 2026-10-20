import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import type {
  IdempotencyScope,
  IdempotencyStore,
} from '../../src/platform/auth/ports/idempotency-store.port.js';
import { OPERATION_RUNNER } from '../../src/platform/authorization/authorization-providers.js';
import { authorizationOf } from '../../src/platform/authorization/authorized-request.js';
import type { OperationRunner } from '../../src/platform/authorization/operation-runner.js';
import type { RecordEntities } from '../../src/platform/authorization/record-scope.js';
import type { Tier, TierRules } from '../../src/platform/authorization/tier-policy.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import {
  AUTH_POLICY_BUNDLE,
  bundleLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import { ContractOperation } from '../../src/platform/contract/contract-operation.js';
import type { JsonObject } from '../../src/platform/contract/json.js';
import { transactionOf } from '../../src/platform/database/transaction-handle.js';
import { ApiException } from '../../src/platform/http/api-exception.js';
import { ErrorCode } from '../../src/platform/http/error-codes.js';
import { fingerprintOfRequest } from '../../src/platform/http/request-fingerprint-input.js';
import { PostgresIdempotencyStore } from '../../src/platform/idempotency/postgres.idempotency-store.adapter.js';
import { requestFingerprint } from '../../src/platform/idempotency/request-fingerprint.js';
import { currentRequestContext } from '../../src/platform/logging/request-context.js';
import { RequiresPermission } from '../../src/platform/routes/access-declaration.js';
import { inspectRoutes } from '../../src/platform/routes/route-inventory.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { observe, type Observer } from './support/observe.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { assemble, staffPersona, type Machinery, type StaffPersona } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import {
  clientFor,
  createTestDatabase,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * Every operation refuses in one order, proved on a fixture operation (S0.26; permission-enforcement.md section 5.1;
 * `AC-SLICE-000-130`; plan `OB-100`, `OB-112`): rate limit, authentication, CSRF and Origin, surface, permission, tier, record
 * scope, validation, idempotency, version, state, maker-checker; the first refusal wins, a refused request has no side effect, and
 * a command's idempotency record, its effect and its answer are one unit of work. The operation is a test's: it is no route of the
 * product, and it is in no inventory of implemented operations.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let observer: Observer;
let machinery: Machinery;
let app: TestApp;
let store: IdempotencyStore;

const OPS = validEnv().OPS_ORIGIN ?? '';
const ACCRA = HUBS[0]?.id ?? '';
const ELSEWHERE = '99999999-9999-4999-8999-999999999999';
const OTHER_MAKER = '4d414b45-0000-4000-8000-000000000009';
const ORDER = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f101';
const ORDER_ELSEWHERE = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f102';
const ORDER_NOT_PENDING = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f103';
const ORDER_NEEDS_P = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f105';
const ORDER_NEEDS_P_ELSEWHERE = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f106';
const ORDER_TO_REVALIDATE = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f107';
const NO_ORDER = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1ff';

const FIXTURE_SQL = `
CREATE TABLE rls_fixture.fixture_orders (
  id uuid PRIMARY KEY,
  responsible_hub_id uuid NOT NULL,
  maker_id uuid NOT NULL,
  state text NOT NULL,
  version integer NOT NULL,
  amount integer NOT NULL DEFAULT 0,
  tier_needed text CHECK (tier_needed IN ('A', 'S', 'P'))
);
ALTER TABLE rls_fixture.fixture_orders OWNER TO melarc_owner;
ALTER TABLE rls_fixture.fixture_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_fixture.fixture_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY fixture_orders_scope ON rls_fixture.fixture_orders
  USING (CASE melarc.principal_type()
    WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids())
    ELSE false END)
  WITH CHECK (CASE melarc.principal_type()
    WHEN 'STAFF' THEN melarc.hub_scope_mode() = 'ALL' OR responsible_hub_id = ANY (melarc.authorized_hub_ids())
    ELSE false END);
CREATE POLICY fixture_orders_probe ON rls_fixture.fixture_orders FOR SELECT
  USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id());
GRANT SELECT, UPDATE ON rls_fixture.fixture_orders TO melarc_api_runtime;
`;

const ENTITIES: RecordEntities = {
  fixture_order: { schema: 'rls_fixture', table: 'fixture_orders', hubScoped: true },
};

/**
 * The tier a target needs, derived from a fact of its own authoritative record (the review of 12 October 2026, F01): never from a
 * value the client sends. A privileged bundle needing a P approver is the shape of the real rules.
 */
const TIER_RULES: TierRules = {
  fixture_order_tier: async (handle, id) => {
    const found = await transactionOf(handle).execute(
      sql`select tier_needed from rls_fixture.fixture_orders where id = ${id}::uuid`,
    );
    const row = found.rows[0] as unknown as { tier_needed: Tier | null } | undefined;
    return row?.tier_needed ?? null;
  },
};

const ORDER_SCHEMA = {
  type: 'object',
  required: ['id', 'state', 'version', 'amount'],
  properties: {
    id: { type: 'string' },
    state: { type: 'string' },
    version: { type: 'integer' },
    amount: { type: 'integer' },
  },
};
const CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Refusal order fixture', version: '1' },
  paths: {
    '/order/records/{id}/adjust': {
      post: {
        operationId: 'adjustFixtureOrder',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 128 },
          },
          {
            name: 'If-Match',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                additionalProperties: false,
                properties: { amount: { type: 'integer', minimum: 1, maximum: 100 } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'adjusted',
            content: { 'application/json': { schema: ORDER_SCHEMA } },
          },
        },
      },
    },
  },
} as unknown as JsonObject;

/** The defect the retained requirement describes: a record still in progress under its key. It has no answer of its own: it is the invariant failure of OB-100, which the pipeline answers with the fixed code-less `500`. */
class StrandedCommandError extends Error {
  constructor() {
    super('a committed idempotency record is still in progress');
    this.name = 'StrandedCommandError';
  }
}

const bytesOf = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

@Controller('order')
class OrderController {
  constructor(
    @Inject(OPERATION_RUNNER) private readonly runner: OperationRunner,
    @Inject('FIXTURE_STORE') private readonly idempotency: IdempotencyStore,
  ) {}

  @Post('records/:id/adjust')
  @HttpCode(200)
  @RequiresPermission('staff.identity.approve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'fixture_order', param: 'id' },
    // Step 6: the grant must carry at least S, whatever the target, and what the target's own record needs besides.
    tier: { minimum: 'S', rule: 'fixture_order_tier' },
  })
  @ContractOperation('adjustFixtureOrder')
  async adjust(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: { amount: number },
    @Headers('idempotency-key') key: string,
    @Headers('if-match') ifMatch: string,
  ): Promise<unknown> {
    const authorized = authorizationOf(request);
    if (authorized === undefined) throw new Error('no authorization decision');
    const done = await this.runner.mutate(
      authorized,
      currentRequestContext()?.requestId ?? 'order-test',
      async (handle) => {
        // 9. Idempotency. begin, the effect and complete are one unit of work: every early return below rolls the record back.
        const scope: IdempotencyScope = {
          principalType: 'STAFF',
          principalId: authorized.session.principalId,
          operationId: 'adjustFixtureOrder',
          key,
        };
        const begun = await this.idempotency.begin(
          handle,
          scope,
          fingerprintOfRequest(request, 'adjustFixtureOrder'),
        );
        switch (begun.outcome) {
          case 'REPLAY':
            return {
              status: begun.response.status,
              body: JSON.parse(new TextDecoder().decode(begun.response.body)) as unknown,
            };
          case 'CONFLICT':
            throw ApiException.of(
              ErrorCode.IdempotencyKeyConflict,
              'The key was used for another request',
            );
          case 'IN_PROGRESS':
          case 'REPLAY_UNAVAILABLE':
            throw new StrandedCommandError();
          case 'NEW':
            break;
        }

        const found = await transactionOf(handle).execute(sql`
          select version, state, maker_id from rls_fixture.fixture_orders where id = ${id}::uuid for update`);
        const row = found.rows[0] as unknown as
          { version: number; state: string; maker_id: string } | undefined;
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
        // 6 again, on the record as this transaction now holds it: what the target needs may have changed while the request waited.
        await this.runner.requireTargetTier(authorized, handle);
        // 10. Version.
        if (ifMatch !== `"${String(row.version)}"`) {
          throw ApiException.of(ErrorCode.StateConflict, 'The record has changed', {
            check: 'version',
          });
        }
        // 11. State.
        if (row.state !== 'PENDING') {
          throw ApiException.of(ErrorCode.StateConflict, 'The record is not pending', {
            check: 'state',
          });
        }
        // 12. Maker-checker, decided last.
        if (row.maker_id === authorized.session.principalId) {
          throw ApiException.of(ErrorCode.SelfApprovalForbidden, 'The maker cannot approve');
        }
        await transactionOf(handle).execute(sql`
          update rls_fixture.fixture_orders set state = 'APPROVED', version = version + 1, amount = ${body.amount}
           where id = ${id}::uuid`);
        const answer = { id, state: 'APPROVED', version: row.version + 1, amount: body.amount };
        await this.idempotency.complete(handle, scope, { status: 200, body: bytesOf(answer) });
        return { status: 200, body: answer };
      },
    );
    response.status(done.status);
    return done.body;
  }
}

/**
 * An operation that changes state and judges nothing itself: whatever it is refused for is the runner's, before its work. The tier is
 * declared as the other operation's is, so that what the runner does with it, and not what the use case does, is what is shown.
 */
@Controller('order')
class TouchController {
  constructor(@Inject(OPERATION_RUNNER) private readonly runner: OperationRunner) {}

  @Post('records/:id/touch')
  @HttpCode(200)
  @RequiresPermission('staff.identity.approve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'fixture_order', param: 'id' },
    tier: { minimum: 'S', rule: 'fixture_order_tier' },
  })
  touch(@Req() request: Request, @Param('id') id: string): Promise<{ touched: number }> {
    const authorized = authorizationOf(request);
    if (authorized === undefined) throw new Error('no authorization decision');
    return this.runner.mutate(authorized, 'order-touch', async (handle) => {
      const result = await transactionOf(handle).execute(
        sql`update rls_fixture.fixture_orders set amount = amount + 1 where id = ${id}::uuid returning 1`,
      );
      return { touched: result.rows.length };
    });
  }
}

@Module({
  controllers: [OrderController, TouchController],
  providers: [{ provide: 'FIXTURE_STORE', useFactory: () => store }],
})
class OrderModule {}

@Module({})
class Root {}

beforeAll(async () => {
  database = await createTestDatabase();
  await withClient(database.urlFor('postgres'), async (client) => {
    await client.query(
      'CREATE SCHEMA IF NOT EXISTS rls_fixture AUTHORIZATION melarc_owner; GRANT USAGE ON SCHEMA rls_fixture TO melarc_api_runtime;',
    );
  });
  await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(FIXTURE_SQL));
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  observer = await observe(database);
  machinery = assemble(built);
  store = new PostgresIdempotencyStore(new AesGcmSecretCipher(localKeys()), machinery.clock);
  const loaded = loadConfig(
    validEnv({ DATABASE_URL: database.urlFor(API_RUNTIME_ROLE), DATABASE_POOL_MAX: '4' }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  app = await startTestApp({
    config: loaded.config,
    contractSource: { load: () => CONTRACT },
    rootModule: (options) => {
      Module({
        imports: [
          AppModule.register({ ...options, recordEntities: ENTITIES, tierRules: TIER_RULES }),
          OrderModule,
        ],
      })(Root);
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

let sequence = 0;
const freshKey = (): string => {
  sequence += 1;
  return `key-${String(sequence)}-${String(Date.now())}`;
};

/** A senior staff member in Accra, and the orders they may act on. */
async function reviewer(
  overrides: { hub?: string | null; bundle?: string } = {},
): Promise<StaffPersona> {
  return staffPersona(machinery, admin, {
    roleBundleId: overrides.bundle ?? BUNDLE_IDS.seniorOps,
    primaryHubId: overrides.hub === undefined ? ACCRA : overrides.hub,
  });
}

async function arrange(
  id: string,
  options: {
    hub?: string;
    maker?: string;
    state?: string;
    version?: number;
    tierNeeded?: Tier | null;
  } = {},
): Promise<void> {
  await admin.query(
    `insert into rls_fixture.fixture_orders (id, responsible_hub_id, maker_id, state, version, tier_needed)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set responsible_hub_id = $2, maker_id = $3, state = $4, version = $5, amount = 0, tier_needed = $6`,
    [
      id,
      options.hub ?? ACCRA,
      options.maker ?? OTHER_MAKER,
      options.state ?? 'PENDING',
      options.version ?? 1,
      options.tierNeeded ?? null,
    ],
  );
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function adjust(
  persona: StaffPersona | undefined,
  id: string,
  options: {
    body?: string;
    key?: string | null;
    ifMatch?: string | null;
    token?: boolean;
    origin?: string | null;
    action?: string;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (persona !== undefined) headers.cookie = persona.cookie;
  if (options.origin !== null) headers.origin = options.origin ?? OPS;
  if (options.token !== false && persona !== undefined) {
    headers['x-csrf-token'] = persona.issued.csrfToken ?? '';
  }
  if (options.key !== null) headers['idempotency-key'] = options.key ?? freshKey();
  if (options.ifMatch !== null) headers['if-match'] = options.ifMatch ?? '"1"';
  const response = await fetch(
    `${app.baseUrl}/api/v1/order/records/${id}/${options.action ?? 'adjust'}`,
    {
      method: 'POST',
      headers,
      body: options.body ?? '{"amount":5}',
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const orderOf = (id: string) =>
  observer.one<{ state: string; version: number; amount: number }>(
    `select state, version, amount from rls_fixture.fixture_orders where id = $1`,
    [id],
  );
const records = (): Promise<number> => observer.count('idempotency_record');

describe('every operation refuses in one order (AC-SLICE-000-130)', () => {
  beforeAll(async () => {
    await arrange(ORDER);
    await arrange(ORDER_ELSEWHERE, { hub: ELSEWHERE });
    await arrange(ORDER_NOT_PENDING, { state: 'APPROVED', version: 4 });
  });

  // Break caught: the schema told to a caller who is not signed in, or to one who may not use the operation: validation before
  // authentication or before permission. A bounded malformed body from either meets the earlier refusal.
  it('refuses a caller with no session 401 and a signed-in caller without the permission 403, whatever the malformed body says', async () => {
    const staff = await reviewer({ bundle: BUNDLE_IDS.opsStaff });
    const malformed = '{ "amount": ';

    const anonymous = await adjust(undefined, ORDER, { body: malformed });
    const lacking = await adjust(staff, ORDER, { body: malformed });

    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('SESSION_INVALID');
    expect(lacking.status).toBe(403);
    expect(lacking.body.code).toBe('PERMISSION_DENIED');
    expect(JSON.stringify([anonymous.body, lacking.body])).not.toMatch(/amount|schema|required/i);
  });

  // Break caught: the CSRF check after the permission, so that a cross-site caller is told whether the permission is held.
  it('refuses a cookie request with no token, and a browser request with a bad Origin, as CSRF before the permission is considered', async () => {
    const lacking = await reviewer({ bundle: BUNDLE_IDS.opsStaff });

    const noToken = await adjust(lacking, ORDER, { token: false });
    const badOrigin = await adjust(lacking, ORDER, { origin: 'https://evil.example' });
    const noOrigin = await adjust(lacking, ORDER, { origin: null });

    for (const answer of [noToken, badOrigin, noOrigin]) {
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('CSRF_VALIDATION_FAILED');
    }
  });

  // Break caught: the record scope after the validation, so that a caller outside the hubs learns whether the body was valid.
  it('refuses a record outside the caller’s hubs, and one that does not exist, before the body is validated', async () => {
    const staff = await reviewer();
    const malformed = '{ "amount": "many" }';

    const outside = await adjust(staff, ORDER_ELSEWHERE, { body: malformed });
    const missing = await adjust(staff, NO_ORDER, { body: malformed });

    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe('HUB_SCOPE_VIOLATION');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  // Break caught: validation missing, or after the idempotency step so that a malformed body spends a key.
  it('answers a malformed body from a caller who may proceed with VALIDATION_FAILED, and spends no key', async () => {
    const staff = await reviewer();
    const before = await records();

    const bad = await adjust(staff, ORDER, { body: '{"amount":"many"}' });
    const noKey = await adjust(staff, ORDER, { key: null });
    const noVersion = await adjust(staff, ORDER, { ifMatch: null });

    for (const answer of [bad, noKey, noVersion]) {
      expect(answer.status).toBe(400);
      expect(answer.body.code).toBe('VALIDATION_FAILED');
    }
    expect(await records()).toBe(before);
  });

  // Break caught: the replay answered after the version or the state, so that a retry of a command that succeeded is told that the
  // record has changed (the very change the first success made).
  it('returns the original answer to a replay, and not a conflict, and changes the record once', async () => {
    const staff = await reviewer();
    await arrange(ORDER);
    const key = freshKey();

    const first = await adjust(staff, ORDER, { key, ifMatch: '"1"' });
    const replay = await adjust(staff, ORDER, { key, ifMatch: '"1"' });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.version).toBe(first.body.version);
    expect({ ...replay.body, request_id: undefined }).toEqual({
      ...first.body,
      request_id: undefined,
    });
    expect(await orderOf(ORDER)).toEqual({ state: 'APPROVED', version: 2, amount: 5 });
  });

  // Break caught: the same key with another body replayed, or served.
  it('refuses the same key with a different body as IDEMPOTENCY_KEY_CONFLICT and changes nothing', async () => {
    const staff = await reviewer();
    await arrange(ORDER);
    const key = freshKey();
    await adjust(staff, ORDER, { key, ifMatch: '"1"' });

    const changed = await adjust(staff, ORDER, { key, ifMatch: '"1"', body: '{"amount":6}' });

    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await orderOf(ORDER)).toEqual({ state: 'APPROVED', version: 2, amount: 5 });
  });

  // Break caught (OB-112): a fingerprint that forgets the path parameters, so two records share one key and one answer.
  it('keeps the same key and body on two different records apart', async () => {
    const staff = await reviewer();
    await arrange(ORDER);
    await arrange('f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f104');
    const key = freshKey();

    const one = await adjust(staff, ORDER, { key, ifMatch: '"1"' });
    const other = await adjust(staff, 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f104', {
      key,
      ifMatch: '"1"',
    });

    expect(one.status).toBe(200);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  // Break caught (steps 10 and 11): the state precondition judged before the version. A stale If-Match on a record that is also not
  // pending is the version's conflict, and the details say which check it was.
  it('decides a stale If-Match before the state precondition, and the state before the maker', async () => {
    const staff = await reviewer();
    await arrange(ORDER_NOT_PENDING, { state: 'APPROVED', version: 4 });

    const stale = await adjust(staff, ORDER_NOT_PENDING, { ifMatch: '"3"' });
    const state = await adjust(staff, ORDER_NOT_PENDING, { ifMatch: '"4"' });

    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STATE_CONFLICT');
    expect(stale.body.details).toEqual({ check: 'version' });
    expect(state.status).toBe(409);
    expect(state.body.details).toEqual({ check: 'state' });
  });

  // Break caught (AC-SLICE-000-130): SELF_APPROVAL_FORBIDDEN decided before the version or the state: it is the last refusal.
  it('decides the maker last: it is refused only when the version and the state are right', async () => {
    const staff = await reviewer();
    await arrange(ORDER, { maker: staff.identity.id });

    const stale = await adjust(staff, ORDER, { ifMatch: '"9"' });
    const own = await adjust(staff, ORDER, { ifMatch: '"1"' });

    expect(stale.body.code).toBe('STATE_CONFLICT');
    expect(own.status).toBe(422);
    expect(own.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  // Break caught: a refusal that has a side effect: a record changed, a key spent, an event written. Every refusal above, and the
  // ones below, leave the record, the idempotency table and the audit exactly as they were.
  it('leaves no trace of any refusal: no record changed, no key spent, no audit event', async () => {
    const staff = await reviewer();
    const lacking = await reviewer({ bundle: BUNDLE_IDS.opsStaff });
    await arrange(ORDER, { maker: staff.identity.id });
    const state = async () => ({
      order: await orderOf(ORDER),
      keys: await records(),
      audit: await observer.count('audit_event'),
    });
    const before = await state();
    const refusals: (() => Promise<Answer>)[] = [
      () => adjust(undefined, ORDER),
      () => adjust(lacking, ORDER),
      () => adjust(staff, ORDER, { token: false }),
      () => adjust(staff, ORDER_ELSEWHERE),
      () => adjust(staff, NO_ORDER),
      () => adjust(staff, ORDER, { body: '{}' }),
      () => adjust(staff, ORDER, { ifMatch: '"9"' }),
      () => adjust(staff, ORDER, { ifMatch: '"1"' }),
    ];

    for (const refuse of refusals) expect((await refuse()).status).toBeGreaterThanOrEqual(400);

    const after = await state();
    // A CSRF rejection is the one thing that is recorded (auth.csrf.rejected); nothing else is.
    expect(after.order).toEqual(before.order);
    expect(after.keys).toBe(before.keys);
    expect(after.audit).toBe(before.audit + 1);
  });
});

describe('the tier is decided at step 6, before the scope and the validation (the review of 12 October 2026, F01)', () => {
  const MALFORMED = '{ "amount": "many" }';
  const state = async () => ({
    keys: await records(),
    audit: await observer.count('audit_event'),
  });

  beforeAll(async () => {
    await arrange(ORDER);
    await arrange(ORDER_ELSEWHERE, { hub: ELSEWHERE });
    await arrange(ORDER_NEEDS_P, { tierNeeded: 'P' });
    await arrange(ORDER_NEEDS_P_ELSEWHERE, { hub: ELSEWHERE, tierNeeded: 'P' });
  });

  // Break caught: the tier left to the operation's own code, which runs after the body is validated, so that a caller who holds the key
  // but not the tier is told about the schema, or that the body was malformed, before they are told they may not.
  it('refuses a held key at too low a tier for the target before the body is validated', async () => {
    const senior = await reviewer();

    const answer = await adjust(senior, ORDER_NEEDS_P, { body: MALFORMED });

    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('INSUFFICIENT_AUTHORITY');
    expect(JSON.stringify(answer.body)).not.toMatch(/amount|schema|required|many/i);
  });

  // Break caught: the minimum of the operation judged after the record is looked for, so that a caller below it learns whether a
  // record exists, or is outside their hubs, before they learn that they may not.
  it('refuses a tier below the operation’s minimum before the record is looked for: before the scope, the existence and the validation', async () => {
    const low = await reviewer({
      bundle: await newBundle(admin, [grant('staff.identity.approve', 'own', 'any', 'A')]),
    });

    const outsideHubs = await adjust(low, ORDER_ELSEWHERE, { body: MALFORMED });
    const absent = await adjust(low, NO_ORDER, { body: MALFORMED });
    const visible = await adjust(low, ORDER, { body: MALFORMED });

    for (const answer of [outsideHubs, absent, visible]) {
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('INSUFFICIENT_AUTHORITY');
    }
  });

  // Break caught (the ambiguity, recorded in permission-enforcement.md section 5.1): what a target needs is a fact of its record, and a
  // caller who may not see the record may not learn it. A requirement the caller could not meet, on a record outside their hubs, is
  // answered by the scope (which the Product decision makes informative), never by a tier that would disclose the record's privilege.
  it('answers by the scope, and not by the tier, for a record the caller may not see', async () => {
    const senior = await reviewer();

    const outside = await adjust(senior, ORDER_NEEDS_P_ELSEWHERE, { body: MALFORMED });
    const absent = await adjust(senior, NO_ORDER, { body: MALFORMED });

    expect([outside.status, outside.body.code]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect([absent.status, absent.body.code]).toEqual([404, 'NOT_FOUND']);
  });

  // Break caught: the tier judged before the permission, so that a caller without the key is told that a higher authority is needed.
  it('lets a missing permission win over the tier', async () => {
    const lacking = await reviewer({ bundle: BUNDLE_IDS.opsStaff });

    const answer = await adjust(lacking, ORDER_NEEDS_P, { body: MALFORMED });

    expect([answer.status, answer.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  // Break caught: the requirement of the target applied to every caller, or ignored for a caller who meets it.
  it('serves a caller whose tier meets the target’s, and one for whom the target needs nothing', async () => {
    const platformAdmin = await reviewer({ bundle: BUNDLE_IDS.platformAdmin });
    const senior = await reviewer();

    const privileged = await adjust(platformAdmin, ORDER_NEEDS_P, { ifMatch: '"1"' });
    const ordinary = await adjust(senior, ORDER, { ifMatch: '"1"' });

    expect(privileged.status).toBe(200);
    expect(ordinary.status).toBe(200);
  });

  // Break caught: a refusal at step 6 that has a side effect: the record changed, a key spent, an event written.
  it('leaves no trace of a refusal at step 6', async () => {
    const senior = await reviewer();
    const low = await reviewer({
      bundle: await newBundle(admin, [grant('staff.identity.approve', 'own', 'any', 'A')]),
    });
    await arrange(ORDER_NEEDS_P, { tierNeeded: 'P' });
    const before = { order: await orderOf(ORDER_NEEDS_P), ...(await state()) };

    for (const refuse of [
      () => adjust(senior, ORDER_NEEDS_P),
      () => adjust(low, ORDER_NEEDS_P),
      () => adjust(low, NO_ORDER),
    ]) {
      expect((await refuse()).status).toBe(403);
    }

    expect({ order: await orderOf(ORDER_NEEDS_P), ...(await state()) }).toEqual(before);
  });

  // Break caught: the requirement read once, by the guard, and trusted by the transaction that acts. A record that became privileged
  // while the request waited for its row is judged again on the row the transaction holds, and nothing is written.
  it('judges the requirement again inside the transaction: a record that became privileged while the request waited is refused', async () => {
    const senior = await reviewer();
    await arrange(ORDER_TO_REVALIDATE);
    const before = await records();
    const holder = clientFor(database.urlFor('postgres'));
    holder.on('error', () => undefined);
    await holder.connect();
    let pending: Promise<Answer>;
    try {
      await holder.query('begin');
      await holder.query(`update rls_fixture.fixture_orders set tier_needed = 'P' where id = $1`, [
        ORDER_TO_REVALIDATE,
      ]);

      // The guard reads the committed record, which needs nothing; the request then waits for the row the holder has.
      pending = adjust(senior, ORDER_TO_REVALIDATE, { ifMatch: '"1"' });
      await waitForBlocked('select version, state');
      await holder.query('commit');
    } finally {
      await holder.end();
    }

    const answer = await pending;

    expect([answer.status, answer.body.code]).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(await orderOf(ORDER_TO_REVALIDATE)).toEqual({ state: 'PENDING', version: 1, amount: 0 });
    expect(await records()).toBe(before);
  });

  // Break caught: the runner trusting the answer the guard got before the request waited for the policy locks. A use case that judges
  // nothing itself is still refused when the target came to need more while it waited, and nothing is written.
  it('judges the requirement again before the work, under the locks the runner holds, whatever the use case does', async () => {
    const senior = await reviewer();
    await arrange(ORDER_TO_REVALIDATE);
    const holder = clientFor(database.urlFor('postgres'));
    holder.on('error', () => undefined);
    await holder.connect();
    let pending: Promise<Answer>;
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1::int4, $2::int4)', [
        AUTH_POLICY_BUNDLE,
        bundleLockKey(BUNDLE_IDS.seniorOps),
      ]);

      // The guard reads the committed record, which needs nothing; the runner then waits for the shared policy lock the holder has.
      pending = adjust(senior, ORDER_TO_REVALIDATE, { action: 'touch' });
      await waitForBlocked('select pg_advisory_xact_lock_shared');
      await admin.query(`update rls_fixture.fixture_orders set tier_needed = 'P' where id = $1`, [
        ORDER_TO_REVALIDATE,
      ]);
      await holder.query('commit');
    } finally {
      await holder.end();
    }

    const answer = await pending;

    expect([answer.status, answer.body.code]).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(await orderOf(ORDER_TO_REVALIDATE)).toEqual({ state: 'PENDING', version: 1, amount: 0 });
  });

  // Control: the same operation, with nothing intervening, is served and writes.
  it('serves the same operation when nothing changed', async () => {
    const senior = await reviewer();
    await arrange(ORDER_TO_REVALIDATE);

    const answer = await adjust(senior, ORDER_TO_REVALIDATE, { action: 'touch' });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ touched: 1 });
  });

  // Break caught: a route naming a tier rule or an entity the application does not have, which the composition of this fixture
  // would otherwise hide because its app is started with the inventory check off.
  it('names only the record entities and the tier rules the application has', () => {
    expect(inspectRoutes(app.app).incoherent).toEqual([]);
  });
});

async function waitForBlocked(start: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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

describe('a command is one unit of work (SECURITY_DESIGN.md section 14.16; OB-100)', () => {
  // Break caught: a record left behind by a command that failed after it began, so that every retry under the key finds it in
  // progress. The failure rolls the record back with the effect, and the retry owns the command.
  it('rolls the idempotency record back with a command that fails after it began, and the retry runs', async () => {
    const staff = await reviewer();
    await arrange(ORDER, { maker: staff.identity.id });
    const key = freshKey();
    const before = await records();

    const refused = await adjust(staff, ORDER, { key, ifMatch: '"1"' });
    expect(refused.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(await records()).toBe(before);

    await arrange(ORDER, { maker: OTHER_MAKER });
    const retried = await adjust(staff, ORDER, { key, ifMatch: '"1"' });

    expect(retried.status).toBe(200);
    expect(await records()).toBe(before + 1);
  });

  it('rolls the record and the effect back together when the write fails in the middle', async () => {
    const staff = await reviewer();
    await arrange(ORDER);
    const key = freshKey();
    const before = await records();
    await admin.query(
      `create or replace function public.melarc_fixture_break() returns trigger language plpgsql as $$ begin raise exception 'write refused' using errcode = 'P0001'; end $$`,
    );
    await admin.query(
      `create trigger melarc_fixture_break before update on rls_fixture.fixture_orders for each row execute function public.melarc_fixture_break()`,
    );
    try {
      const failed = await adjust(staff, ORDER, { key, ifMatch: '"1"' });
      expect(failed.status).toBe(500);
    } finally {
      await admin.query('drop trigger melarc_fixture_break on rls_fixture.fixture_orders');
    }

    expect(await records()).toBe(before);
    expect(await orderOf(ORDER)).toEqual({ state: 'PENDING', version: 1, amount: 0 });
    expect((await adjust(staff, ORDER, { key, ifMatch: '"1"' })).status).toBe(200);
  });

  // Break caught (the retained observation of section 14.16): a concurrent duplicate that sees IN_PROGRESS. It does not: its begin
  // waits on the unique index until the first transaction ends, then finds the saved answer. The first is held open by a lock on the
  // record, and both are watched on the server, never timed.
  it('makes a concurrent duplicate wait for the first command and replay its answer, and changes the record once', async () => {
    const staff = await reviewer();
    await arrange(ORDER);
    const key = freshKey();
    const holder = clientFor(database.urlFor('postgres'));
    holder.on('error', () => undefined);
    await holder.connect();
    let first: Promise<Answer>;
    let second: Promise<Answer>;
    try {
      await holder.query('begin');
      await holder.query('select 1 from rls_fixture.fixture_orders where id = $1 for update', [
        ORDER,
      ]);

      first = adjust(staff, ORDER, { key, ifMatch: '"1"' });
      await waitForBlocked('select version, state');
      second = adjust(staff, ORDER, { key, ifMatch: '"1"' });
      await waitForBlocked('insert into idempotency_record');
      await holder.query('commit');
    } finally {
      await holder.end();
    }

    const [one, two] = await Promise.all([first, second]);

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.version).toBe(one.body.version);
    expect(await orderOf(ORDER)).toEqual({ state: 'APPROVED', version: 2, amount: 5 });
  });

  // The distinction the review of 12 October 2026 asks to be kept (OB-100): a duplicate that waits for a first command that has begun
  // and not ended, and runs out of time, is answered with the platform's operational failure. That is not the invariant failure of a
  // committed record left in progress (the test below), and nothing reclaims or retries on a fresh key: when the first command ends,
  // the same key owns the command again. The first command here is a transaction of the test that holds an uncommitted record.
  it('answers a duplicate whose wait runs out of time with the operational failure, not the invariant failure, and reclaims nothing', async () => {
    const staff = await reviewer();
    await arrange(ORDER);
    const key = freshKey();
    const print = requestFingerprint({
      operationId: 'adjustFixtureOrder',
      pathParameters: { id: ORDER },
      body: { amount: 5 },
    });
    const holder = clientFor(database.urlFor('postgres'));
    holder.on('error', () => undefined);
    await holder.connect();
    let waited: Answer;
    try {
      await holder.query('begin');
      await holder.query(
        `insert into idempotency_record (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state)
         values (gen_random_uuid(), 'STAFF', $1, 'adjustFixtureOrder', $2, $3, 'IN_PROGRESS')`,
        [staff.identity.id, key, print],
      );

      // The duplicate waits on the unique index of the uncommitted record until the lock time runs out.
      waited = await adjust(staff, ORDER, { key, ifMatch: '"1"' });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }

    expect(waited.status).toBe(503);
    expect(waited.body).not.toHaveProperty('code');
    expect(await orderOf(ORDER)).toEqual({ state: 'PENDING', version: 1, amount: 0 });

    // The first command ended without committing: nothing was left in progress, and the same key runs the command.
    const retried = await adjust(staff, ORDER, { key, ifMatch: '"1"' });
    expect(retried.status).toBe(200);
    expect(await orderOf(ORDER)).toEqual({ state: 'APPROVED', version: 2, amount: 5 });
  });

  // OB-100 (SECURITY_DESIGN.md section 14.16; decided by the owner on 12 October 2026, plan section 7.20): a record that was
  // committed still in progress, which only a command assembled wrongly can leave, is an internal invariant failure. It is answered
  // with the platform's fixed unexpected failure (`500`, no code: no contract code is added), never as a success or a replay, with
  // nothing changed, and nothing reclaims it automatically.
  it('fails closed, and does not answer as a success or a replay, for a stranded record that is still in progress', async () => {
    const staff = await reviewer();
    await arrange(ORDER);
    const key = freshKey();
    const print = requestFingerprint({
      operationId: 'adjustFixtureOrder',
      pathParameters: { id: ORDER },
      body: { amount: 5 },
    });
    await admin.query(
      `insert into idempotency_record (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state)
       values (gen_random_uuid(), 'STAFF', $1, 'adjustFixtureOrder', $2, $3, 'IN_PROGRESS')`,
      [staff.identity.id, key, print],
    );

    const answer = await adjust(staff, ORDER, { key, ifMatch: '"1"' });

    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({
      message: 'Internal server error',
      request_id: expect.any(String) as unknown,
    });
    expect(await orderOf(ORDER)).toEqual({ state: 'PENDING', version: 1, amount: 0 });
    expect(
      (
        await observer.one<{ state: string }>(
          `select state from idempotency_record where idempotency_key = $1`,
          [key],
        )
      )?.state,
    ).toBe('IN_PROGRESS');
  });
});
