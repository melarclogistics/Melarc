import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import type {
  IdempotencyScope,
  IdempotencyStart,
} from '../../src/platform/auth/ports/idempotency-store.port.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { IdempotencyRefusedError } from '../../src/platform/idempotency/idempotency-scope.js';
import { PostgresIdempotencyStore } from '../../src/platform/idempotency/postgres.idempotency-store.adapter.js';
import { requestFingerprint } from '../../src/platform/idempotency/request-fingerprint.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import {
  HUB_A,
  PRINCIPAL_1,
  PRINCIPAL_2,
  VENDOR_1,
  applyFixture,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import {
  createTestDatabase,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.12 against a real PostgreSQL: the idempotency record and its store, as `melarc_api_runtime` (the login the API connects as).
 * Security test matrix Family I (principal-scoped keys, `GBT-I1` to `I7` as far as the store reaches), Family T for the sealed
 * replay's erasure, and SECURITY_DESIGN.md §14.16 (the one operation that replays a secret). The deadline-driven cleanup of
 * expired records is S0.19's; the pipeline that maps the outcomes to HTTP answers is S0.20's.
 */

// The disclosure window is judged on the database's clock, so the clock the grant's expiry is computed on starts at the real time.
const clock = new ManualClock(new Date());
const cipher = new AesGcmSecretCipher(localKeys());
const store = new PostgresIdempotencyStore(cipher, clock);

const STAFF_A = staffContext([HUB_A]);
const STAFF_B: SecurityContext = { ...staffContext([HUB_A]), principalId: PRINCIPAL_2 };
/** A vendor principal that has the same id as STAFF_A: the type is part of the identity. */
const VENDOR_SAME_ID = vendorContext(VENDOR_1);

let database: TestDatabase;
let built: BuiltService;
let admin: Admin;
let observer: Observer;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  built = buildService(database, { poolMax: 2 });
  admin = await openAdmin(database);
  observer = await observe(database);
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await built.close();
  await database.drop();
});

const FINGERPRINT = requestFingerprint({
  operationId: 'createStaffIdentity',
  body: { name: 'Ama' },
});
const OTHER_FINGERPRINT = requestFingerprint({
  operationId: 'createStaffIdentity',
  body: { name: 'Kofi' },
});
const BODY = new Uint8Array([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x31, 0x7d]);

let counter = 0;
/** A key no other test uses, so that tests do not depend on each other's records. */
const freshKey = (label: string): string => `${label}-${String((counter += 1))}`;

const scopeOf = (
  context: SecurityContext,
  key: string,
  operationId = 'createStaffIdentity',
): IdempotencyScope => ({
  principalType: context.principalType as IdempotencyScope['principalType'],
  principalId: context.principalId,
  operationId,
  key,
});

/** Begins a command in a transaction of its own and, when it may run, completes it and commits. */
async function run(
  context: SecurityContext,
  scope: IdempotencyScope,
  fingerprint = FINGERPRINT,
  body: Uint8Array = BODY,
): Promise<IdempotencyStart> {
  return withHandle(built.service, context, async (handle) => {
    const start = await store.begin(handle, scope, fingerprint);
    if (start.outcome === 'NEW') await store.complete(handle, scope, { status: 201, body });
    return start;
  });
}

async function stateOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
}

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error instanceof IdempotencyRefusedError ? error.code : `other: ${String(error)}`;
  }
}

const recordCount = async (match: Record<string, unknown>): Promise<number> =>
  observer.count('idempotency_record', match);

describe('a key is one principal’s one command', () => {
  // Break caught: a second request under the same key and request running the command again.
  it('replays the saved answer, byte for byte, for the same key and the same request', async () => {
    const key = freshKey('replay');
    const scope = scopeOf(STAFF_A, key);
    const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);

    expect((await run(STAFF_A, scope, FINGERPRINT, everyByte)).outcome).toBe('NEW');
    const again = await run(STAFF_A, scope);

    expect(again.outcome).toBe('REPLAY');
    if (again.outcome !== 'REPLAY') return;
    expect(again.response.status).toBe(201);
    expect([...again.response.body]).toEqual([...everyByte]);
    expect(again.sealed).toBeUndefined();
    expect(await recordCount({ idempotency_key: key })).toBe(1);
  });

  // Break caught: the same key with another request being answered with the first request's result.
  it('is a conflict when the same key comes with another request, saved or in progress', async () => {
    const key = freshKey('conflict');
    const scope = scopeOf(STAFF_A, key);
    await run(STAFF_A, scope);

    expect((await run(STAFF_A, scope, OTHER_FINGERPRINT)).outcome).toBe('CONFLICT');
    expect((await run(STAFF_A, scope)).outcome).toBe('REPLAY');

    // A command that began and never completed (its transaction ended with the record and not the answer).
    const open = scopeOf(STAFF_A, freshKey('conflict-open'));
    await withHandle(built.service, STAFF_A, (handle) => store.begin(handle, open, FINGERPRINT));
    expect((await run(STAFF_A, open, OTHER_FINGERPRINT)).outcome).toBe('CONFLICT');
  });

  // Break caught: a command that is still in progress being run a second time under its key.
  it('reports a command that began and did not finish as in progress, and runs it no second time', async () => {
    const scope = scopeOf(STAFF_A, freshKey('in-progress'));
    const first = await withHandle(built.service, STAFF_A, (handle) =>
      store.begin(handle, scope, FINGERPRINT),
    );
    expect(first.outcome).toBe('NEW');

    expect((await run(STAFF_A, scope)).outcome).toBe('IN_PROGRESS');
    expect((await run(STAFF_A, scope)).outcome).toBe('IN_PROGRESS');
  });

  // Break caught: another principal's response being returned for the same text key (GBT-I1; the defect of R0).
  it('gives each principal a namespace of its own for the same text key', async () => {
    const key = freshKey('shared-text');
    expect((await run(STAFF_A, scopeOf(STAFF_A, key))).outcome).toBe('NEW');

    // Another staff member, and a vendor with the same id as the first: both are new commands, whatever the key says.
    expect((await run(STAFF_B, scopeOf(STAFF_B, key))).outcome).toBe('NEW');
    expect((await run(VENDOR_SAME_ID, scopeOf(VENDOR_SAME_ID, key))).outcome).toBe('NEW');
    expect(await recordCount({ idempotency_key: key })).toBe(3);

    // And each replays its own, not the others'.
    const answers = new Map<string, Uint8Array>();
    for (const [name, context, body] of [
      ['a', STAFF_A, new Uint8Array([1])],
      ['b', STAFF_B, new Uint8Array([2])],
    ] as const) {
      const scope = scopeOf(context, freshKey(`own-${name}`));
      await run(context, scope, FINGERPRINT, body);
      const replay = await run(context, scope);
      if (replay.outcome === 'REPLAY') answers.set(name, replay.response.body);
    }
    expect([...(answers.get('a') ?? [])]).toEqual([1]);
    expect([...(answers.get('b') ?? [])]).toEqual([2]);
  });

  // Break caught: one operation's key colliding with another's under the same principal (GBT-I2).
  it('gives each operation of one principal a namespace of its own for the same text key', async () => {
    const key = freshKey('two-operations');

    expect((await run(STAFF_A, scopeOf(STAFF_A, key, 'createStaffIdentity'))).outcome).toBe('NEW');
    expect((await run(STAFF_A, scopeOf(STAFF_A, key, 'approveStaffIdentity'))).outcome).toBe('NEW');
    expect(await recordCount({ idempotency_key: key })).toBe(2);
  });

  // Break caught: a transaction that fails leaving a record behind, so that the retry is answered "in progress" for ever.
  it('leaves nothing behind when the command’s transaction fails, so the retry runs it again', async () => {
    const scope = scopeOf(STAFF_A, freshKey('rolled-back'));

    await expect(
      withHandle(built.service, STAFF_A, async (handle) => {
        await store.begin(handle, scope, FINGERPRINT);
        throw new Error('the command failed');
      }),
    ).rejects.toThrow('the command failed');

    expect(await recordCount({ idempotency_key: scope.key })).toBe(0);
    expect((await run(STAFF_A, scope)).outcome).toBe('NEW');
  });
});

describe('two requests at once for one key', () => {
  /** Waits, by looking at the server, until `count` sessions of the runtime login wait on a lock. */
  async function waitForBlocked(count: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const row = await observer.one<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = $1 and usename = 'melarc_api_runtime' and wait_event_type = 'Lock'`,
        [database.name],
      );
      if ((row?.n ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the second request never waited for the first');
  }

  // Break caught: both requests believing they own the command (a lost update of the saved answer, a command run twice).
  it('lets one run the command and gives the other its answer, once the first has committed', async () => {
    const scope = scopeOf(STAFF_A, freshKey('race'));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstOutcome: IdempotencyStart['outcome'] | undefined;
    let secondOutcome: IdempotencyStart['outcome'] | undefined;

    const first = withHandle(built.service, STAFF_A, async (handle) => {
      const start = await store.begin(handle, scope, FINGERPRINT);
      firstOutcome = start.outcome;
      await held;
      await store.complete(handle, scope, { status: 201, body: BODY });
    });
    // The first has begun (its row exists, uncommitted) before the second starts.
    for (let attempt = 0; attempt < 500 && firstOutcome === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = withHandle(built.service, STAFF_A, async (handle) => {
      const start = await store.begin(handle, scope, FINGERPRINT);
      secondOutcome = start.outcome;
    });

    await waitForBlocked(1);
    expect(secondOutcome).toBeUndefined();
    release();
    await Promise.all([first, second]);

    expect(firstOutcome).toBe('NEW');
    expect(secondOutcome).toBe('REPLAY');
    expect(await recordCount({ idempotency_key: scope.key })).toBe(1);
  });

  // Break caught: the waiting request losing the command when the first fails, so that nobody runs it.
  it('lets the waiting request own the command when the first one rolls back', async () => {
    const scope = scopeOf(STAFF_A, freshKey('race-rollback'));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstOutcome: IdempotencyStart['outcome'] | undefined;
    let secondOutcome: IdempotencyStart['outcome'] | undefined;

    const first = withHandle(built.service, STAFF_A, async (handle) => {
      firstOutcome = (await store.begin(handle, scope, FINGERPRINT)).outcome;
      await held;
      throw new Error('the first command failed');
    });
    for (let attempt = 0; attempt < 500 && firstOutcome === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = withHandle(built.service, STAFF_A, async (handle) => {
      const start = await store.begin(handle, scope, FINGERPRINT);
      secondOutcome = start.outcome;
      if (start.outcome === 'NEW') await store.complete(handle, scope, { status: 201, body: BODY });
    });

    await waitForBlocked(1);
    release();
    await expect(first).rejects.toThrow('the first command failed');
    await second;

    expect(firstOutcome).toBe('NEW');
    expect(secondOutcome).toBe('NEW');
    expect(await recordCount({ idempotency_key: scope.key, state: 'COMPLETED' })).toBe(1);
  });
});

describe('completing a command', () => {
  // Break caught: an answer recorded for a command this transaction never began (it would forge or overwrite another's).
  it('completes only a command this transaction began', async () => {
    const scope = scopeOf(STAFF_A, freshKey('never-begun'));

    expect(
      await refusedWith(
        withHandle(built.service, STAFF_A, (handle) =>
          store.complete(handle, scope, { status: 201, body: BODY }),
        ),
      ),
    ).toBe('SCOPE_NOT_OPEN');

    // Begun in one transaction, completed in another: the second did not begin it.
    const split = scopeOf(STAFF_A, freshKey('begun-elsewhere'));
    await withHandle(built.service, STAFF_A, (handle) => store.begin(handle, split, FINGERPRINT));
    expect(
      await refusedWith(
        withHandle(built.service, STAFF_A, (handle) =>
          store.complete(handle, split, { status: 201, body: BODY }),
        ),
      ),
    ).toBe('SCOPE_NOT_OPEN');
    expect(await recordCount({ idempotency_key: split.key, state: 'IN_PROGRESS' })).toBe(1);
  });

  // Break caught: a saved answer replaced by a second completion.
  it('completes a command once', async () => {
    const scope = scopeOf(STAFF_A, freshKey('twice'));

    const outcome = await refusedWith(
      withHandle(built.service, STAFF_A, async (handle) => {
        await store.begin(handle, scope, FINGERPRINT);
        await store.complete(handle, scope, { status: 201, body: BODY });
        await store.complete(handle, scope, { status: 200, body: new Uint8Array([9]) });
      }),
    );

    expect(outcome).toBe('SCOPE_NOT_OPEN');
    expect(await recordCount({ idempotency_key: scope.key })).toBe(0);
  });

  // Break caught: a status the contract cannot answer, or a body that is not bytes, being saved.
  it('refuses an answer that is not a status and bytes', async () => {
    for (const bad of [
      { status: 99, body: BODY },
      { status: 600, body: BODY },
      { status: 200.5, body: BODY },
      { status: 200, body: 'text' as never },
    ]) {
      const scope = scopeOf(STAFF_A, freshKey('bad-answer'));
      expect(
        await refusedWith(
          withHandle(built.service, STAFF_A, async (handle) => {
            await store.begin(handle, scope, FINGERPRINT);
            await store.complete(handle, scope, bad);
          }),
        ),
      ).toBe('IDEMPOTENCY_SCOPE_REFUSED');
    }
  });

  // Break caught: a transaction naming another principal's key, or a SYSTEM transaction keying a command.
  it('refuses a scope that is not the transaction’s principal’s, and keys nothing for a SYSTEM transaction', async () => {
    const key = freshKey('not-mine');

    expect(
      await refusedWith(
        withHandle(built.service, STAFF_A, (handle) =>
          store.begin(handle, scopeOf(STAFF_B, key), FINGERPRINT),
        ),
      ),
    ).toBe('IDEMPOTENCY_SCOPE_REFUSED');
    expect(
      await refusedWith(
        withHandle(built.service, systemContext('authentication'), (handle) =>
          store.begin(handle, scopeOf(STAFF_A, key), FINGERPRINT),
        ),
      ),
    ).toBe('IDEMPOTENCY_SCOPE_REFUSED');
    expect(await recordCount({ idempotency_key: key })).toBe(0);
  });
});

describe('the sealed replay of registerRiderDevice (SECURITY_DESIGN.md §14.16)', () => {
  const OPERATION = 'registerRiderDevice';
  const SECRET = new TextEncoder().encode(
    '{"grantToken":"SENTINEL-grant-token-91b2","challenge":"SENTINEL-challenge-47c1"}',
  );
  const RIDER_FINGERPRINT = requestFingerprint({
    operationId: OPERATION,
    body: { riderId: 'r-1' },
  });
  const WINDOW_MS = 60 * 60 * 1000;

  const registerScope = (context: SecurityContext, key: string) => scopeOf(context, key, OPERATION);
  const inOneHour = () => new Date(clock.now().getTime() + WINDOW_MS);

  async function register(
    context: SecurityContext,
    scope: IdempotencyScope,
    expiresAt = inOneHour(),
  ): Promise<string> {
    return withHandle(built.service, context, async (handle) => {
      const start = await store.begin(handle, scope, RIDER_FINGERPRINT);
      if (start.outcome !== 'NEW') throw new Error(`expected NEW, got ${start.outcome}`);
      await store.complete(
        handle,
        scope,
        { status: 201, body: new TextEncoder().encode('{"deviceId":"d-1"}') },
        { plaintext: SECRET, expiresAt },
      );
      return start.recordId;
    });
  }

  const beginAgain = (context: SecurityContext, scope: IdempotencyScope) =>
    withHandle(built.service, context, (handle) => store.begin(handle, scope, RIDER_FINGERPRINT));

  // Break caught: the secret fields stored in the clear, or the ordinary response carrying them.
  it('stores the secret fields sealed and the rest of the answer as for any operation', async () => {
    const scope = registerScope(STAFF_A, freshKey('sealed-store'));
    await register(STAFF_A, scope);

    const row = await observer.one<{ stored: string; sealed: boolean; body: string }>(
      `select idempotency_record::text as stored, (sealed_ciphertext is not null) as sealed, convert_from(response_body, 'UTF8') as body
         from idempotency_record where idempotency_key = $1`,
      [scope.key],
    );
    expect(row?.sealed).toBe(true);
    expect(row?.body).toBe('{"deviceId":"d-1"}');
    expect(row?.stored).not.toContain('SENTINEL');
    // The hex of the bytea columns is searched as well: neither the text nor its encoding is in the row.
    const hex = Buffer.from(SECRET).toString('hex');
    expect(
      await observer.rows(
        "select 1 from idempotency_record where encode(sealed_ciphertext, 'hex') like $1",
        [`%${hex.slice(0, 16)}%`],
      ),
    ).toEqual([]);
  });

  // Break caught: the retry of a registration not getting the secret it was sent, or getting something else.
  it('replays the secret to the same principal, key and request while the window is open, as often as it asks', async () => {
    const scope = registerScope(STAFF_A, freshKey('sealed-replay'));
    await register(STAFF_A, scope);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await beginAgain(STAFF_A, scope);
      expect(replay.outcome).toBe('REPLAY');
      if (replay.outcome !== 'REPLAY') return;
      expect(Buffer.from(replay.sealed ?? []).toString('utf8')).toBe(
        Buffer.from(SECRET).toString('utf8'),
      );
      expect(Buffer.from(replay.response.body).toString('utf8')).toBe('{"deviceId":"d-1"}');
    }
  });

  // Break caught: a changed request being answered with the first request’s secret.
  it('is a conflict, and discloses nothing, when the request changed', async () => {
    const scope = registerScope(STAFF_A, freshKey('sealed-conflict'));
    await register(STAFF_A, scope);

    const other = await withHandle(built.service, STAFF_A, (handle) =>
      store.begin(
        handle,
        scope,
        requestFingerprint({ operationId: OPERATION, body: { riderId: 'r-2' } }),
      ),
    );

    expect(other).toEqual({ outcome: 'CONFLICT' });
  });

  // Break caught: another principal receiving the secret of a key it shares by text (the disclosure channel of R0).
  it('never discloses the secret to another principal with the same text key', async () => {
    const key = freshKey('sealed-other-principal');
    await register(STAFF_A, registerScope(STAFF_A, key));

    const other = await register(STAFF_B, registerScope(STAFF_B, key));

    expect(other).toMatch(/^[0-9a-f-]{36}$/);
    const replayB = await beginAgain(STAFF_B, registerScope(STAFF_B, key));
    expect(replayB.outcome).toBe('REPLAY');
    expect(await recordCount({ idempotency_key: key })).toBe(2);
  });

  // Break caught: the disclosure window judged on the application's clock, or not judged at all on read (a delayed cleanup would extend it).
  it('closes the window on the database’s clock when it is read, erases the ciphertext and runs nothing again', async () => {
    const scope = registerScope(STAFF_A, freshKey('sealed-expiry'));
    await register(STAFF_A, scope);
    expect((await beginAgain(STAFF_A, scope)).outcome).toBe('REPLAY');

    // Age the window by SQL, as the database sees it: the application's clock is not touched. The guard refuses any change of the
    // sealed fields but their erasure, so the administrator switches it off for the one statement, as a test of time must.
    await admin.query('alter table idempotency_record disable trigger idempotency_record_guard');
    try {
      await admin.ageRows('idempotency_record', 'sealed_expires_at', '2 hours', {
        idempotency_key: scope.key,
      });
    } finally {
      await admin.query('alter table idempotency_record enable trigger idempotency_record_guard');
    }

    expect(await beginAgain(STAFF_A, scope)).toEqual({ outcome: 'REPLAY_UNAVAILABLE' });
    const row = await observer.one<{ sealed: boolean; tombstoned: boolean }>(
      'select (sealed_ciphertext is not null) as sealed, (replay_unavailable_at is not null) as tombstoned from idempotency_record where idempotency_key = $1',
      [scope.key],
    );
    expect(row).toEqual({ sealed: false, tombstoned: true });
    expect(await beginAgain(STAFF_A, scope)).toEqual({ outcome: 'REPLAY_UNAVAILABLE' });
    expect(await recordCount({ idempotency_key: scope.key })).toBe(1);
  });

  // Break caught: the grant’s consumption leaving the secret replayable until its expiry.
  it('ends the window in the same commit as the transaction that consumes the grant', async () => {
    const scope = registerScope(STAFF_A, freshKey('sealed-consumed'));
    const recordId = await register(STAFF_A, scope);

    const erased = await withHandle(built.service, STAFF_A, (handle) =>
      store.eraseSealedReplay(handle, recordId),
    );
    expect(erased).toBe(true);
    expect(await beginAgain(STAFF_A, scope)).toEqual({ outcome: 'REPLAY_UNAVAILABLE' });
    expect(
      await withHandle(built.service, STAFF_A, (handle) =>
        store.eraseSealedReplay(handle, recordId),
      ),
    ).toBe(false);

    // The erasure belongs to the transaction: one that rolls back leaves the secret where it was.
    const second = registerScope(STAFF_A, freshKey('sealed-consumed-rollback'));
    const secondId = await register(STAFF_A, second);
    await expect(
      withHandle(built.service, STAFF_A, async (handle) => {
        await store.eraseSealedReplay(handle, secondId);
        throw new Error('the consuming transaction failed');
      }),
    ).rejects.toThrow('the consuming transaction failed');
    expect((await beginAgain(STAFF_A, second)).outcome).toBe('REPLAY');
  });

  // Break caught: the erasure reaching a record its context cannot see, or the authentication capability unable to erase.
  it('erases for the authentication capability, for the owner, and for nobody else', async () => {
    const scope = registerScope(STAFF_A, freshKey('sealed-who'));
    const recordId = await register(STAFF_A, scope);

    const erase = (context: SecurityContext) =>
      withHandle(built.service, context, (handle) => store.eraseSealedReplay(handle, recordId));

    expect(await erase(STAFF_B)).toBe(false);
    expect(await erase(VENDOR_SAME_ID)).toBe(false);
    expect(await erase(systemContext('rate_limit'))).toBe(false);
    expect((await beginAgain(STAFF_A, scope)).outcome).toBe('REPLAY');

    expect(await erase(systemContext('authentication'))).toBe(true);
    expect(await beginAgain(STAFF_A, scope)).toEqual({ outcome: 'REPLAY_UNAVAILABLE' });
  });

  // Break caught (review of 10 October 2026, finding 3): the authentication capability reading or changing more than the erasure of
  // a sealed replay (the registry: "erasing the sealed columns only"), so that it could read another principal's saved answer,
  // complete another principal's command with an answer of its own, or lengthen the window in which a secret can be replayed.
  it('gives the authentication capability the sealed replay to erase and nothing else of the table', async () => {
    const system = systemContext('authentication');
    // An update that names no column of the table is judged by the UPDATE policy alone (one that reads a column is also judged by
    // the SELECT policy, which would hide a flaw in the first), so it is tried against a table with one record in progress and no
    // other: any record that is completed would fail the statement on the guard trigger, for the right policy and the wrong one alike.
    await admin.query('delete from idempotency_record');
    const open = scopeOf(STAFF_A, freshKey('auth-open'));
    await withHandle(built.service, STAFF_A, (handle) => store.begin(handle, open, FINGERPRINT));
    const everything = await withHandle(built.service, system, (_handle, tx) =>
      tx.execute(
        sql`update idempotency_record set state = 'COMPLETED', completed_at = now(), response_status = 200, response_body = decode('00', 'hex')`,
      ),
    );
    expect(everything.rowCount).toBe(0);
    const plain = scopeOf(STAFF_A, freshKey('auth-plain'));
    await run(STAFF_A, plain);
    const sealed = registerScope(STAFF_A, freshKey('auth-sealed'));
    await register(STAFF_A, sealed);

    const visible = (key: string) =>
      withHandle(built.service, system, async (_handle, tx) => {
        const result = await tx.execute(
          sql`select count(*)::int as n from idempotency_record where idempotency_key = ${key}`,
        );
        return (result.rows[0] as { n: number }).n;
      });
    const update = (key: string, assignment: ReturnType<typeof sql>) =>
      withHandle(built.service, system, (_handle, tx) =>
        tx.execute(sql`update idempotency_record set ${assignment} where idempotency_key = ${key}`),
      );
    const stateOfRecord = async (key: string) =>
      await observer.one<{ state: string; status: number | null; sealed: boolean }>(
        `select state, response_status as status, (sealed_ciphertext is not null) as sealed
             from idempotency_record where idempotency_key = $1`,
        [key],
      );

    // It sees the records that carry a sealed replay, and no other: not a saved answer, not a command in progress.
    expect(await visible(sealed.key)).toBe(1);
    expect(await visible(plain.key)).toBe(0);
    expect(await visible(open.key)).toBe(0);

    // It cannot complete a command in progress with an answer of its own, nor change a saved one.
    const forged = sql`state = 'COMPLETED', completed_at = now(), response_status = 200, response_body = decode('00', 'hex')`;
    expect((await update(open.key, forged)).rowCount).toBe(0);
    expect(await stateOfRecord(open.key)).toMatchObject({ state: 'IN_PROGRESS', status: null });
    expect((await update(plain.key, sql`response_status = 200`)).rowCount).toBe(0);
    expect(await stateOfRecord(plain.key)).toMatchObject({ state: 'COMPLETED', status: 201 });

    // It cannot lengthen the window of a sealed replay, nor change it in any way but erasing it.
    expect(
      await stateOf(
        update(sealed.key, sql`sealed_expires_at = sealed_expires_at + interval '1 day'`),
      ),
    ).toBeDefined();
    expect(await stateOfRecord(sealed.key)).toMatchObject({ sealed: true });
  });

  // Break caught: the exception widening to another operation, or the one operation completing without its secret.
  it('is for registerRiderDevice only, and registerRiderDevice always seals', async () => {
    const other = scopeOf(STAFF_A, freshKey('sealed-other-operation'));
    expect(
      await refusedWith(
        withHandle(built.service, STAFF_A, async (handle) => {
          await store.begin(handle, other, FINGERPRINT);
          await store.complete(
            handle,
            other,
            { status: 201, body: BODY },
            { plaintext: SECRET, expiresAt: inOneHour() },
          );
        }),
      ),
    ).toBe('SEALED_REPLAY_REFUSED');

    const rider = registerScope(STAFF_A, freshKey('sealed-missing'));
    expect(
      await refusedWith(
        withHandle(built.service, STAFF_A, async (handle) => {
          await store.begin(handle, rider, RIDER_FINGERPRINT);
          await store.complete(handle, rider, { status: 201, body: BODY });
        }),
      ),
    ).toBe('SEALED_REPLAY_REFUSED');
    expect(await recordCount({ idempotency_key: other.key })).toBe(0);
  });

  // Break caught: a window that is already closed, or a secret of no length, being stored.
  it('refuses a window that has already closed and an empty secret', async () => {
    const past = new Date(clock.now().getTime() - 1);
    for (const sealed of [
      { plaintext: SECRET, expiresAt: past },
      { plaintext: SECRET, expiresAt: new Date('nope') },
      { plaintext: new Uint8Array(0), expiresAt: inOneHour() },
    ]) {
      const scope = registerScope(STAFF_A, freshKey('sealed-bad-window'));
      expect(
        await refusedWith(
          withHandle(built.service, STAFF_A, async (handle) => {
            await store.begin(handle, scope, RIDER_FINGERPRINT);
            await store.complete(handle, scope, { status: 201, body: BODY }, sealed);
          }),
        ),
      ).toBe('SEALED_REPLAY_REFUSED');
    }
  });

  // Break caught: an envelope that opens for a record it was not sealed for (GBT-V: associated data binds principal, operation, record).
  it('does not open an envelope moved to another record', async () => {
    const first = registerScope(STAFF_A, freshKey('sealed-moved-a'));
    const second = registerScope(STAFF_A, freshKey('sealed-moved-b'));
    await register(STAFF_A, first);
    await register(STAFF_A, second);

    // The guard trigger refuses this as it refuses any update; an administrator switches it off to attempt the move.
    await admin.query('alter table idempotency_record disable trigger idempotency_record_guard');
    try {
      await admin.query(
        `update idempotency_record t set sealed_ciphertext = s.sealed_ciphertext, sealed_nonce = s.sealed_nonce,
                sealed_key_version = s.sealed_key_version, sealed_envelope_version = s.sealed_envelope_version
           from idempotency_record s where t.idempotency_key = $1 and s.idempotency_key = $2`,
        [second.key, first.key],
      );
    } finally {
      await admin.query('alter table idempotency_record enable trigger idempotency_record_guard');
    }

    await expect(beginAgain(STAFF_A, second)).rejects.toMatchObject({
      condition: 'AUTHENTICATION_FAILED',
    });
    expect((await beginAgain(STAFF_A, first)).outcome).toBe('REPLAY');
  });
});

describe('what the table itself holds to', () => {
  const insertRaw = (columns: Record<string, string> = {}) => {
    const row: Record<string, string> = {
      id: 'gen_random_uuid()',
      principal_type: "'STAFF'",
      principal_id: `'${PRINCIPAL_1}'`,
      operation_id: "'createStaffIdentity'",
      idempotency_key: `'${freshKey('raw')}'`,
      fingerprint: `'${FINGERPRINT}'`,
      state: "'IN_PROGRESS'",
      ...columns,
    };
    return admin.query(
      `insert into idempotency_record (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`,
    );
  };

  // Break caught: a record that breaks the table’s own rules being storable by anyone.
  it('refuses a record outside the closed sets and bounds', async () => {
    const refused: Record<string, string>[] = [
      { principal_type: "'SYSTEM'" },
      { principal_type: "'ADMIN'" },
      { operation_id: "'not a name'" },
      { idempotency_key: "''" },
      { idempotency_key: `'${'k'.repeat(129)}'` },
      { fingerprint: "'short'" },
      { fingerprint: `'${'A'.repeat(64)}'` },
      { state: "'DONE'" },
      { state: "'COMPLETED'" },
      { state: "'IN_PROGRESS'", response_status: '200' },
      {
        state: "'COMPLETED'",
        response_status: '99',
        response_body: "'\\x00'::bytea",
        completed_at: 'now()',
      },
      { sealed_ciphertext: "'\\x00'::bytea" },
    ];
    for (const bad of refused) {
      await expect(insertRaw(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514' });
    }
  });

  // Break caught: a saved answer being replaced, the sealed fields being put back or the identity changed, by anyone.
  it('keeps a saved answer, an identity and an erasure from being undone, even for the administrator', async () => {
    const scope = scopeOf(STAFF_A, freshKey('guard'));
    await run(STAFF_A, scope);

    for (const change of [
      "response_body = '\\x00'::bytea",
      'response_status = 200',
      "state = 'IN_PROGRESS'",
      'completed_at = now()',
      `fingerprint = '${OTHER_FINGERPRINT}'`,
      "idempotency_key = 'renamed'",
      "operation_id = 'otherOperation'",
      `principal_id = '${PRINCIPAL_2}'`,
      "created_at = now() + interval '1 day'",
      'replay_unavailable_at = now()',
    ]) {
      await expect(
        admin.query(`update idempotency_record set ${change} where idempotency_key = $1`, [
          scope.key,
        ]),
        change,
      ).rejects.toMatchObject({ code: '23514' });
    }

    // The sealed fields cannot be set on a record that was completed without them, or replaced, or half erased.
    await expect(
      admin.query(
        `update idempotency_record set sealed_ciphertext = '\\x01'::bytea, sealed_nonce = '\\x02'::bytea, sealed_key_version = 1,
                sealed_envelope_version = 1, sealed_expires_at = now() + interval '1 hour' where idempotency_key = $1`,
        [scope.key],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: a runtime login able to remove or empty the records, which only the retention cleanup (S0.19) will.
  it('lets no runtime login delete or truncate a record, and the API runtime read, insert and update only', async () => {
    for (const login of ['melarc_api_runtime', WORKER_RUNTIME_ROLE, PROVISIONING_ROLE] as const) {
      await withClient(database.urlFor(login), async (client) => {
        expect(await sqlState(client, 'delete from idempotency_record'), `${login} delete`).toBe(
          '42501',
        );
        expect(await sqlState(client, 'truncate idempotency_record'), `${login} truncate`).toBe(
          '42501',
        );
      });
    }
    for (const login of [WORKER_RUNTIME_ROLE, PROVISIONING_ROLE]) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
        const held = await observer.one<{ held: boolean }>(
          'select has_table_privilege($1, $2, $3) as held',
          [login, 'public.idempotency_record', privilege],
        );
        expect(held?.held, `${login} ${privilege}`).toBe(false);
      }
    }
  });

  // Break caught: row-level security letting one principal read, write or even see another’s records (GBT-I1), or a SYSTEM context under the wrong capability.
  it('shows a principal only its own records and the authentication capability none of the unsealed ones', async () => {
    const key = freshKey('visibility');
    await run(STAFF_A, scopeOf(STAFF_A, key));
    await run(STAFF_B, scopeOf(STAFF_B, key));
    const countFor = (context: SecurityContext) =>
      withHandle(built.service, context, async (_handle, tx) => {
        const result = await tx.execute(
          sql`select count(*)::int as n from idempotency_record where idempotency_key = ${key}`,
        );
        return (result.rows[0] as { n: number }).n;
      });

    expect(await countFor(STAFF_A)).toBe(1);
    expect(await countFor(STAFF_B)).toBe(1);
    expect(await countFor(VENDOR_SAME_ID)).toBe(0);
    expect(await countFor(systemContext('rate_limit'))).toBe(0);
    // The authentication capability reaches a record only to erase its sealed replay (finding 3 of the review): neither record
    // here has one, so it sees neither. The sealed ones are in the test of that capability above.
    expect(await countFor(systemContext('authentication'))).toBe(0);

    // A SYSTEM context inserts no record, and a staff context cannot insert one for another principal.
    const insertAs = (context: SecurityContext, principalId: string, type: string) =>
      withHandle(built.service, context, async (_handle, tx) => {
        await tx.execute(sql`insert into idempotency_record (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state)
          values (gen_random_uuid(), ${type}, ${principalId}::uuid, 'createStaffIdentity', ${freshKey('rls')}, ${FINGERPRINT}, 'IN_PROGRESS')`);
      });
    expect(await stateOf(insertAs(systemContext('authentication'), PRINCIPAL_1, 'STAFF'))).toBe(
      '42501',
    );
    expect(await stateOf(insertAs(STAFF_A, PRINCIPAL_2, 'STAFF'))).toBe('42501');
    expect(await stateOf(insertAs(STAFF_A, PRINCIPAL_1, 'VENDOR'))).toBe('42501');
  });
});
