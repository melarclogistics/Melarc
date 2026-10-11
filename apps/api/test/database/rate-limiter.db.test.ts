import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LimiterDigest } from '../../src/platform/auth/crypto/limiter-digest.js';
import type { Clock } from '../../src/platform/auth/ports/clock.port.js';
import {
  RATE_LIMIT_BUCKETS,
  type RateLimitBucket,
} from '../../src/platform/auth/ports/rate-limiter.port.js';
import {
  RATE_LIMIT_CAPACITY,
  RATE_LIMIT_KEY,
  rateLimitLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { BoundedMetrics } from '../../src/platform/metrics/bounded.metrics.adapter.js';
import {
  LimiterKeyVersionError,
  LimiterUnavailableError,
} from '../../src/platform/limiter/limiter-errors.js';
import {
  CLEANUP_BATCH,
  MAX_KEY_BYTES,
  WINDOW_SECONDS,
} from '../../src/platform/limiter/limiter-parameters.js';
import {
  PostgresRateLimiter,
  liveVersionsNotHeldStatement,
} from '../../src/platform/limiter/postgres.rate-limiter.adapter.js';
import { SettingsBucketLimits } from '../../src/platform/limiter/bucket-limits.js';
import { SettingsReader } from '../../src/platform/settings/settings-reader.js';
import { localKeys, purposeKeys } from '../../src/test-support/key-config.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import { staffContext, systemContext, vendorContext, HUB_A } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, withClient, type TestDatabase } from './support/test-database.js';

/**
 * S0.14 against a real PostgreSQL: the authoritative rate limiter over `rate_limit_admission`, as `melarc_api_runtime` opening the
 * `rate_limit` capability. Security test matrix Family O (O5) and SECURITY_DESIGN.md §14.12: the exact threshold under concurrent
 * admission, expiry, a flood of distinct identifiers, capacity exhaustion, store outage, key rotation, and no counter incremented on
 * a refusal. The two-process proof is `rate-limiter-processes.db.test.ts`.
 */

const MIGRATION = readFileSync(
  resolve(import.meta.dirname, '../../migrations/0008_rate_limit_admission.sql'),
  'utf8',
).replaceAll('\r', '');

const STAFF_SIGNIN: RateLimitBucket = 'rate_limit_staff_signin';
/** The launch values of settings.md §7.7. */
const LAUNCH: Readonly<Record<RateLimitBucket, number>> = {
  rate_limit_staff_signin: 10,
  rate_limit_privileged_mfa: 10,
  rate_limit_vendor_signin: 10,
  rate_limit_rider_challenge: 20,
  rate_limit_recovery: 10,
  rate_limit_authenticated_api: 120,
};

let database: TestDatabase;
let built: BuiltService;
let admin: Admin;
let observer: Observer;
let keyCounter = 0;
const freshKey = (label: string): string => `${label}-${String((keyCounter += 1))}@example.test`;

/** The machine's clock, moved by `offset` milliseconds: the limiter must not decide on it, whatever it says. */
class OffsetClock implements Clock {
  constructor(private readonly offset = 0) {}
  now(): Date {
    return new Date(Date.now() + this.offset);
  }
  monotonicMilliseconds(): number {
    return performance.now();
  }
}
const clock = new OffsetClock();

/** A limiter over the real service, its limits read from the seeded settings the way the product reads them. */
function limiterFor(
  service = built.service,
  options: {
    keys?: ReturnType<typeof localKeys>;
    maxTotalRows?: number;
    cleanupBatch?: number;
    metrics?: BoundedMetrics;
  } = {},
): PostgresRateLimiter {
  return new PostgresRateLimiter({
    database: service,
    digest: new LimiterDigest(options.keys ?? KEYS),
    limits: new SettingsBucketLimits(new SettingsReader()),
    clock,
    ...(options.maxTotalRows === undefined ? {} : { maxTotalRows: options.maxTotalRows }),
    ...(options.cleanupBatch === undefined ? {} : { cleanupBatch: options.cleanupBatch }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
}

const KEYS = localKeys();

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 8 });
  admin = await openAdmin(database);
  observer = await observe(database);
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await built.close();
  await database.drop();
});

afterEach(async () => {
  await admin.query('delete from rate_limit_admission');
});

const rowCount = async (): Promise<number> =>
  (await observer.one<{ n: number }>('select count(*)::int as n from rate_limit_admission'))?.n ??
  0;

/** Admits `times` requests one after another and returns how many were allowed. */
async function admitMany(
  limiter: PostgresRateLimiter,
  bucket: RateLimitBucket,
  key: string,
  times: number,
): Promise<{ allowed: number; last: Awaited<ReturnType<PostgresRateLimiter['admit']>> }> {
  let allowed = 0;
  let last: Awaited<ReturnType<PostgresRateLimiter['admit']>> = { allowed: true };
  for (let attempt = 0; attempt < times; attempt += 1) {
    last = await limiter.admit(bucket, key);
    if (last.allowed) allowed += 1;
  }
  return { allowed, last };
}

describe('the threshold of a bucket', () => {
  // Break caught: an off-by-one at the limit, or a limit read from anywhere but the settings (here, the contract's launch values).
  it('admits exactly the configured number in a window, for each of the six buckets, and refuses the next', async () => {
    const limiter = limiterFor();

    for (const bucket of RATE_LIMIT_BUCKETS) {
      const key = freshKey(bucket);
      const { allowed, last } = await admitMany(limiter, bucket, key, LAUNCH[bucket] + 1);

      expect(allowed, bucket).toBe(LAUNCH[bucket]);
      expect(last.allowed, bucket).toBe(false);
    }
    expect(RATE_LIMIT_BUCKETS).toHaveLength(6);
  });

  // Break caught: a refused request writing a row (it would extend the penalty), or a decision that is not a count of what is admitted.
  it('counts only what it admits: a refusal writes nothing and changes nothing', async () => {
    const limiter = limiterFor();
    const key = freshKey('refusal');
    await admitMany(limiter, STAFF_SIGNIN, key, 10);
    expect(await rowCount()).toBe(10);

    const refusals = await admitMany(limiter, STAFF_SIGNIN, key, 25);

    expect(refusals.allowed).toBe(0);
    expect(await rowCount()).toBe(10);
  });

  // Break caught: one caller’s exhaustion refusing another caller, or one bucket’s count read as another’s.
  it('keeps each key, and each bucket, to its own allowance', async () => {
    const limiter = limiterFor();
    const key = freshKey('shared');
    await admitMany(limiter, STAFF_SIGNIN, key, 10);

    expect((await limiter.admit(STAFF_SIGNIN, key)).allowed).toBe(false);
    expect((await limiter.admit(STAFF_SIGNIN, freshKey('other'))).allowed).toBe(true);
    expect((await limiter.admit('rate_limit_vendor_signin', key)).allowed).toBe(true);
    expect((await limiter.admit('rate_limit_recovery', key)).allowed).toBe(true);
  });

  // Break caught: a fixed window (a double burst at its boundary) in place of a rolling one.
  it('is a rolling window: the rows that have left it free their places, one by one', async () => {
    const limiter = limiterFor();
    const key = freshKey('rolling');
    await admitMany(limiter, STAFF_SIGNIN, key, 10);
    // Four of the ten were admitted 70 seconds ago, the other six a moment ago.
    await admin.query(
      `update rate_limit_admission set admitted_at = admitted_at - interval '70 seconds'
        where id in (select id from rate_limit_admission order by admitted_at limit 4)`,
    );

    const { allowed, last } = await admitMany(limiter, STAFF_SIGNIN, key, 6);

    expect(allowed).toBe(4);
    expect(last.allowed).toBe(false);
  });

  // Break caught: a retry time that does not say when a place frees (too early sends the client back to be refused; too late costs it).
  it('tells a refused caller how long until a place frees, from the row whose leaving frees it', async () => {
    const limiter = limiterFor();
    const key = freshKey('retry');
    await admitMany(limiter, STAFF_SIGNIN, key, 10);
    await admin.query(
      `update rate_limit_admission set admitted_at = admitted_at - interval '50 seconds'
        where id in (select id from rate_limit_admission order by admitted_at limit 1)`,
    );

    const refused = await limiter.admit(STAFF_SIGNIN, key);

    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    // The oldest row was admitted 50 seconds ago and leaves the window in 10.
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(9);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(11);
  });

  // Break caught: a window other than the contract’s 60 seconds in the database, or in the code.
  it('uses the 60-second window of the contract in the code and in the policy of DELETE', () => {
    expect(WINDOW_SECONDS).toBe(60);
    expect(MIGRATION).toContain(`interval '${String(WINDOW_SECONDS)} seconds'`);
  });
});

describe('time is the database’s, and in the rolling window only', () => {
  // Break caught: the decision taken on the application’s clock, so that two instances with different clocks disagree.
  it('does not read the application’s clock for the window', async () => {
    const skewed = new OffsetClock(-10 * 24 * 3600 * 1000);
    const limiter = new PostgresRateLimiter({
      database: built.service,
      digest: new LimiterDigest(KEYS),
      limits: new SettingsBucketLimits(new SettingsReader()),
      clock: skewed,
    });
    const key = freshKey('skew');

    const { allowed } = await admitMany(limiter, STAFF_SIGNIN, key, 12);

    expect(allowed).toBe(10);
  });
});

describe('what is stored', () => {
  // Break caught: an identifier, an address or a token reaching storage (SECURITY_DESIGN.md §14.12: a keyed digest only).
  it('stores a keyed digest and the bucket and the time, and not the key', async () => {
    const limiter = limiterFor();
    const key = 'Ama.Mensah@example.test';
    await limiter.admit(STAFF_SIGNIN, key);

    const row = await observer.one<{
      stored: string;
      digest: string;
      version: number;
      bucket: string;
    }>(
      `select rate_limit_admission::text as stored, encode(key_digest, 'hex') as digest, digest_version as version, bucket
         from rate_limit_admission`,
    );
    expect(row?.bucket).toBe(STAFF_SIGNIN);
    expect(row?.version).toBe(1);
    expect(row?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.stored.toLowerCase()).not.toContain('ama');
    expect(row?.stored).not.toContain('example.test');
    expect(row?.stored).not.toContain('Mensah');
  });

  // Break caught: the same canonical key digesting differently each time (an allowance that resets), or two keys sharing a digest.
  it('digests the same key to the same row key, and different keys to different ones', async () => {
    const limiter = limiterFor();
    await limiter.admit(STAFF_SIGNIN, 'same@example.test');
    await limiter.admit(STAFF_SIGNIN, 'same@example.test');
    await limiter.admit(STAFF_SIGNIN, 'other@example.test');

    const rows = await observer.rows<{ n: number }>(
      'select count(*)::int as n from rate_limit_admission group by key_digest order by n desc',
    );
    expect(rows.map((row) => row.n)).toEqual([2, 1]);
  });

  // Break caught: an oversize key reaching the digest and the store, or being truncated into another caller’s key.
  it('refuses a key longer than the bound, uniformly, without writing', async () => {
    const limiter = limiterFor();

    const refused = await limiter.admit(STAFF_SIGNIN, 'k'.repeat(MAX_KEY_BYTES + 1));

    expect(refused).toEqual({ allowed: false, retryAfterSeconds: WINDOW_SECONDS });
    expect(await rowCount()).toBe(0);
    expect((await limiter.admit(STAFF_SIGNIN, 'k'.repeat(MAX_KEY_BYTES))).allowed).toBe(true);
  });

  // Break caught: a bucket that is not one of the six being counted (there is no seventh).
  it('refuses a bucket that is not one of the six', async () => {
    const limiter = limiterFor();

    await expect(limiter.admit('rate_limit_seventh' as never, 'x')).rejects.toThrow(TypeError);
    await expect(
      limiter.admit('report_export_initiation_ceiling_per_minute' as never, 'x'),
    ).rejects.toThrow(TypeError);
    expect(await rowCount()).toBe(0);
  });
});

describe('capacity is bounded and never evicts a live penalty', () => {
  // Break caught: expired rows never removed, or removed without a bound (a sweep inside a request).
  it('removes a bounded batch of expired rows in each admission, and only expired ones', async () => {
    const limiter = limiterFor();
    await admin.query(
      `insert into rate_limit_admission (bucket, key_digest, digest_version, admitted_at)
       select 'rate_limit_authenticated_api', decode(lpad(to_hex(g), 64, '0'), 'hex'), 1, clock_timestamp() - interval '2 minutes'
         from generate_series(1, 250) as g`,
    );
    expect(await rowCount()).toBe(250);

    await limiter.admit(STAFF_SIGNIN, freshKey('cleanup'));
    expect(await rowCount()).toBe(250 - CLEANUP_BATCH + 1);
    await limiter.admit(STAFF_SIGNIN, freshKey('cleanup'));
    expect(await rowCount()).toBe(250 - 2 * CLEANUP_BATCH + 2);
    await limiter.admit(STAFF_SIGNIN, freshKey('cleanup'));
    // 250 expired rows are gone; the three admitted rows are live and stay.
    expect(await rowCount()).toBe(3);
    expect(await observer.count('rate_limit_admission', { bucket: STAFF_SIGNIN })).toBe(3);
  });

  // Break caught: the database letting the limiter delete a row that still counts (the guard is in the policy, not only the code).
  it('lets the rate_limit capability delete a row only after it has left the window', async () => {
    const limiter = limiterFor();
    const key = freshKey('policy');
    await limiter.admit(STAFF_SIGNIN, key);
    await admin.query(
      `insert into rate_limit_admission (bucket, key_digest, digest_version, admitted_at)
       values ('rate_limit_recovery', decode(repeat('ab', 32), 'hex'), 1, clock_timestamp() - interval '2 minutes')`,
    );

    const deleted = await withHandle(
      built.service,
      systemContext('rate_limit'),
      async (_handle, tx) => {
        const live = await tx.execute(
          sql`delete from rate_limit_admission where bucket = ${STAFF_SIGNIN} returning id`,
        );
        const expired = await tx.execute(
          sql`delete from rate_limit_admission where bucket = 'rate_limit_recovery' returning id`,
        );
        return { live: live.rows.length, expired: expired.rows.length };
      },
    );

    expect(deleted).toEqual({ live: 0, expired: 1 });
    expect(await rowCount()).toBe(1);
  });

  // Break caught: capacity exhausted by invented keys flushing another caller’s bucket, or a limiter that keeps admitting past its bound.
  it('refuses new admissions uniformly at capacity and evicts nothing', async () => {
    const limiter = limiterFor(built.service, { maxTotalRows: 5 });
    const victim = freshKey('victim');
    await admitMany(limiter, STAFF_SIGNIN, victim, 3);
    for (const label of ['a', 'b']) await limiter.admit(STAFF_SIGNIN, freshKey(label));
    expect(await rowCount()).toBe(5);

    // A flood of distinct identifiers: every one refused, none evicts the victim’s rows.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refused = await limiter.admit(STAFF_SIGNIN, freshKey('invented'));
      expect(refused.allowed).toBe(false);
      if (!refused.allowed) {
        expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(refused.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);
      }
    }
    expect(await rowCount()).toBe(5);

    // The victim is under its limit and is refused too: at capacity nothing is added, for anyone. Its three rows still stand.
    expect((await limiter.admit(STAFF_SIGNIN, victim)).allowed).toBe(false);
    expect(await rowCount()).toBe(5);

    // Capacity frees as rows leave the window, and then admissions resume.
    await admin.query(
      `update rate_limit_admission set admitted_at = admitted_at - interval '2 minutes'`,
    );
    expect((await limiter.admit(STAFF_SIGNIN, victim)).allowed).toBe(true);
  });
});

describe('two requests at once for one key', () => {
  // Break caught: concurrent decisions for one key each seeing room, so that more than the limit are admitted.
  it('never admits more than the limit when many arrive together', async () => {
    const limiter = limiterFor();
    const key = freshKey('burst');

    // Forty callers at once: each takes two connections in turn (the limit, then the admission), so this stays inside the
    // service's bounded line of waiters (fifty) and every caller gets its decision.
    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => limiter.admit(STAFF_SIGNIN, key)),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(await rowCount()).toBe(10);
  });

  // Break caught (review of 10 October 2026, finding 8): one lock for all keys, or a lock a caller holds across keys, so that
  // admissions for different keys queue behind one another. Both admissions are stopped inside their transactions by a table lock,
  // after they have taken their key locks; both key locks must then be granted at the same moment. A single lock for every key
  // would grant one and leave the other waiting, whatever digest the test holds.
  it('lets admissions for different keys hold their key locks at the same time', async () => {
    const limiter = limiterFor();
    const digest = new LimiterDigest(KEYS);
    const keys = [freshKey('overlap'), freshKey('overlap')];
    const expected = keys.flatMap((key) =>
      digest.digestsFor(STAFF_SIGNIN, key).all.map((entry) => rateLimitLockKey(entry.bytes) >>> 0),
    );
    const grantedKeys = async (): Promise<number[]> =>
      (
        await observer.rows<{ objid: string }>(
          `select objid::text as objid from pg_locks
            where locktype = 'advisory' and classid = $1::oid and granted`,
          [RATE_LIMIT_KEY],
        )
      ).map((row) => Number(row.objid));

    const decisions = await withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      // The first statement of an admission after its key locks is the check on key versions: it stops here, locks held.
      await client.query('lock table rate_limit_admission in access exclusive mode');
      const both = Promise.all(keys.map((key) => limiter.admit(STAFF_SIGNIN, key)));
      try {
        const deadline = Date.now() + 5_000;
        let granted = await grantedKeys();
        while (!expected.every((key) => granted.includes(key)) && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          granted = await grantedKeys();
        }
        expect(granted.toSorted((a, b) => a - b)).toEqual(
          [...new Set(expected)].toSorted((a, b) => a - b),
        );
      } finally {
        await client.query('rollback');
      }
      return both;
    });

    expect(decisions).toEqual([{ allowed: true }, { allowed: true }]);
  });

  // Break caught: serialisation across keys, so that one caller’s burst holds up every other caller.
  it('is not held up by the lock of another key', async () => {
    const limiter = limiterFor();
    const held = freshKey('held');
    const digest = new LimiterDigest(KEYS).digestsFor(STAFF_SIGNIN, held).active.bytes;
    const holder = await withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1::int4, $2::int4)', [
        RATE_LIMIT_KEY,
        digest.readInt32BE(0),
      ]);
      // With the lock on one key held, another key is admitted at once.
      const other = await limiter.admit(STAFF_SIGNIN, freshKey('free'));
      await client.query('rollback');
      return other;
    });

    expect(holder.allowed).toBe(true);
  });
});

describe('a store that cannot answer fails closed', () => {
  // Break caught: a permissive fallback when the store cannot be reached.
  it('raises LIMITER_STORE_UNAVAILABLE, and admits nothing, when the connection pool is closed', async () => {
    const closing = buildService(database, { poolMax: 2 });
    const limiter = limiterFor(closing.service);
    await closing.close();

    const failure = await limiter
      .admit(STAFF_SIGNIN, freshKey('outage'))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LimiterUnavailableError);
    expect((failure as LimiterUnavailableError).code).toBe('LIMITER_STORE_UNAVAILABLE');
    expect(await rowCount()).toBe(0);
  });

  // Break caught: a write the store refuses being answered as an admission.
  it('raises, and counts nothing, when the store fails the write', async () => {
    const limiter = limiterFor();
    const broken = await admin.breakWrites('rate_limit_admission');
    try {
      const failure = await limiter
        .admit(STAFF_SIGNIN, freshKey('write'))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LimiterUnavailableError);
      expect(serverErrorIn((failure as Error).cause)?.code, String((failure as Error).cause)).toBe(
        'P0001',
      );
    } finally {
      await broken.mend();
    }
    expect(await rowCount()).toBe(0);
    expect((await limiter.admit(STAFF_SIGNIN, freshKey('after'))).allowed).toBe(true);
  });

  // Break caught: a limiter waiting for ever on a key’s lock, or answering a lock timeout as an admission.
  it('raises when the key’s lock cannot be taken within the server’s lock time', async () => {
    const quick = buildService(database, {
      poolMax: 2,
      deadlines: {
        acquireTimeoutMs: 2_000,
        lockTimeoutMs: 300,
        statementTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 6_000,
        transactionTimeoutMs: 8_000,
        maxWaiters: 10,
      },
    });
    try {
      const limiter = limiterFor(quick.service);
      const key = freshKey('locked');
      const digest = new LimiterDigest(KEYS).digestsFor(STAFF_SIGNIN, key).active.bytes;
      const failure = await withClient(database.urlFor('postgres'), async (client) => {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock($1::int4, $2::int4)', [
          RATE_LIMIT_KEY,
          digest.readInt32BE(0),
        ]);
        try {
          return await limiter.admit(STAFF_SIGNIN, key).catch((error: unknown) => error);
        } finally {
          await client.query('rollback');
        }
      });

      expect(failure).toBeInstanceOf(LimiterUnavailableError);
      expect(await rowCount()).toBe(0);
    } finally {
      await quick.close();
    }
  });

  // Break caught: a limit that is missing or invalid being read as "no limit".
  it('raises when the bucket’s limit is missing or invalid, and never admits on it', async () => {
    const limiter = limiterFor();
    await admin.query("update setting set value = '\"ten\"' where key = 'rate_limit_staff_signin'");
    try {
      const failure = await limiter
        .admit(STAFF_SIGNIN, freshKey('invalid'))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LimiterUnavailableError);
    } finally {
      await admin.query("update setting set value = '10' where key = 'rate_limit_staff_signin'");
    }
    await admin.query("update setting set value = '0' where key = 'rate_limit_staff_signin'");
    try {
      expect(
        await limiter.admit(STAFF_SIGNIN, freshKey('zero')).catch((error: unknown) => error),
      ).toBeInstanceOf(LimiterUnavailableError);
    } finally {
      await admin.query("update setting set value = '10' where key = 'rate_limit_staff_signin'");
    }
    expect(await rowCount()).toBe(0);
  });
});

describe('rotating the digest key does not reset an allowance', () => {
  // Break caught: a new key version hiding the rows written under the old one, so that a rotation resets every bucket.
  it('counts the rows of every held version, writes under the active one, and forgets a version only after it is retired', async () => {
    const versionOne = purposeKeys([1]);
    const key = freshKey('rotation');
    const before = limiterFor(built.service, { keys: localKeys({ limiter_digest: versionOne }) });
    await admitMany(before, STAFF_SIGNIN, key, 10);

    // Version 2 is added and made active; version 1 is still held for the lookup.
    const both = {
      activeVersion: 2,
      versions: { ...versionOne.versions, ...purposeKeys([2]).versions },
    };
    const during = limiterFor(built.service, { keys: localKeys({ limiter_digest: both }) });
    expect((await during.admit(STAFF_SIGNIN, key)).allowed).toBe(false);

    // The rows age out of the window; the next admission is written under version 2.
    await admin.query(
      `update rate_limit_admission set admitted_at = admitted_at - interval '2 minutes'`,
    );
    expect((await during.admit(STAFF_SIGNIN, key)).allowed).toBe(true);
    const versions = await observer.rows<{ digest_version: number; n: number }>(
      `select digest_version, count(*)::int as n from rate_limit_admission
        where admitted_at > clock_timestamp() - interval '60 seconds' group by digest_version`,
    );
    expect(versions).toEqual([{ digest_version: 2, n: 1 }]);

    // A limiter holding only version 2 (version 1 retired) counts the version-2 rows and no others.
    const after = limiterFor(built.service, {
      keys: localKeys({
        limiter_digest: { activeVersion: 2, versions: { 2: both.versions[2] ?? never() } },
      }),
    });
    const { allowed } = await admitMany(after, STAFF_SIGNIN, key, 12);
    expect(allowed).toBe(9);
  });
});

describe('who may reach the table', () => {
  // Break caught: a context other than the rate_limit capability reading or writing the admissions, or UPDATE existing for anyone.
  it('refuses a staff, a vendor and every other capability, and has no UPDATE', async () => {
    const limiter = limiterFor();
    await limiter.admit(STAFF_SIGNIN, freshKey('table'));

    const attempt = async (
      context: ReturnType<typeof staffContext>,
      statement: ReturnType<typeof sql>,
    ) => {
      try {
        const rows = await withHandle(built.service, context, (_handle, tx) =>
          tx.execute(statement),
        );
        return `rows:${String(rows.rows.length)}`;
      } catch (error) {
        return serverErrorIn(error)?.code ?? String(error);
      }
    };
    const insert = sql`insert into rate_limit_admission (bucket, key_digest, digest_version) values ('rate_limit_recovery', decode(repeat('cd', 32), 'hex'), 1)`;
    const select = sql`select id from rate_limit_admission`;

    for (const context of [
      staffContext([HUB_A], 'ALL'),
      vendorContext('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
      systemContext('authentication'),
    ]) {
      expect(await attempt(context, select), context.principalType).toMatch(/^rows:0$|42501/);
      expect(await attempt(context, insert), context.principalType).toBe('42501');
    }
    expect(await attempt(systemContext('rate_limit'), select)).toBe('rows:1');
    expect(
      await attempt(
        systemContext('rate_limit'),
        sql`update rate_limit_admission set bucket = 'rate_limit_recovery'`,
      ),
    ).toBe('42501');
    expect(await rowCount()).toBe(1);
  });
});

function never(): never {
  throw new Error('unreachable');
}

describe('refusals are counted per bucket and per cause, and carry no identifier', () => {
  const rateLimited = (metrics: BoundedMetrics) =>
    Object.fromEntries(
      metrics
        .snapshot()
        .counters.filter((entry) => entry.name === 'rate_limited_total')
        .map((entry) => [`${entry.labels.bucket ?? ''}/${entry.labels.cause ?? ''}`, entry.value]),
    );

  // Break caught: a refusal not counted, counted under the wrong bucket or cause, or an admission counted as a refusal.
  it('counts a ceiling, a full table and a key too long, each under its own cause, and no admission', async () => {
    const metrics = new BoundedMetrics({ policy: 'throw', clock });
    const limiter = limiterFor(built.service, { maxTotalRows: 12, metrics });
    const key = freshKey('counted');
    await admitMany(limiter, STAFF_SIGNIN, key, 12);
    expect(rateLimited(metrics)).toEqual({ 'rate_limit_staff_signin/BUCKET_CEILING': 2 });

    // The table now holds ten live rows for this key; two more keys fill it, then a new key meets the cap.
    await limiter.admit('rate_limit_vendor_signin', freshKey('fill'));
    await limiter.admit('rate_limit_vendor_signin', freshKey('fill'));
    await limiter.admit('rate_limit_recovery', freshKey('invented'));
    await limiter.admit(STAFF_SIGNIN, 'k'.repeat(MAX_KEY_BYTES + 1));

    expect(rateLimited(metrics)).toEqual({
      'rate_limit_staff_signin/BUCKET_CEILING': 2,
      'rate_limit_recovery/STORE_CAPACITY': 1,
      'rate_limit_staff_signin/KEY_TOO_LONG': 1,
    });
    expect(JSON.stringify(metrics.snapshot())).not.toContain('example.test');
  });
});

describe('instances that hold different versions of the digest key (G2-04)', () => {
  const material = purposeKeys([1, 2, 3]);
  /** The configuration of an instance that holds `versions` of one key and writes under `active`. */
  const holding = (versions: readonly number[], active: number) =>
    localKeys({
      limiter_digest: {
        activeVersion: active,
        versions: Object.fromEntries(
          versions.map((version) => [version, material.versions[version] ?? never()]),
        ),
      },
    });
  const liveVersions = () =>
    observer.rows<{ digest_version: number; n: number }>(
      `select digest_version, count(*)::int as n from rate_limit_admission
        where admitted_at > clock_timestamp() - interval '60 seconds' group by digest_version order by 1`,
    );
  /** Alternates between the limiters, `times` attempts in all, and counts the admissions. */
  async function alternate(
    limiters: readonly PostgresRateLimiter[],
    key: string,
    times: number,
  ): Promise<number> {
    let allowed = 0;
    for (let attempt = 0; attempt < times; attempt += 1) {
      const limiter = limiters[attempt % limiters.length];
      if ((await (limiter ?? never()).admit(STAFF_SIGNIN, key)).allowed) allowed += 1;
    }
    return allowed;
  }

  // Break caught: instances that hold the same versions and write under different ones counting only their own rows, so that the
  // allowance is the limit for each instance and not for the key. The two share the lock of the version they both hold.
  it('shares one allowance between instances that hold the same versions and write under different ones', async () => {
    const one = limiterFor(built.service, { keys: holding([1, 2], 1) });
    const two = limiterFor(built.service, { keys: holding([1, 2], 2) });

    expect(await alternate([one, two], freshKey('shared'), 24)).toBe(10);

    expect(await liveVersions()).toEqual([
      { digest_version: 1, n: 5 },
      { digest_version: 2, n: 5 },
    ]);
  });

  // Break caught: the same, under concurrency: the lock excludes the two, and each counts what the other wrote.
  it('shares it exactly when both arrive together', async () => {
    const one = limiterFor(built.service, { keys: holding([1, 2], 1) });
    const two = limiterFor(built.service, { keys: holding([1, 2], 2) });
    const key = freshKey('together');

    const decisions = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? one : two).admit(STAFF_SIGNIN, key),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(await rowCount()).toBe(10);
  });

  // Break caught: the first stage of the rotation (the new key is distributed while the old one stays active) changing an allowance.
  it('keeps the exact allowance while the new version is held by some instances and written by none', async () => {
    const old = limiterFor(built.service, { keys: holding([1], 1) });
    const distributed = limiterFor(built.service, { keys: holding([1, 2], 1) });

    expect(await alternate([old, distributed], freshKey('stage-one'), 24)).toBe(10);

    expect(await liveVersions()).toEqual([{ digest_version: 1, n: 10 }]);
  });

  // Break caught (the defect): an instance that holds only version 1 counting a key's allowance short because another instance
  // writes the key under version 2. The two share version 1's lock, which orders them and proves nothing about what each can count:
  // the old instance would admit the key's whole allowance again. It refuses instead, for every key, and writes nothing.
  it('refuses an instance that cannot count a version that is live, and writes nothing', async () => {
    const old = limiterFor(built.service, { keys: holding([1], 1) });
    const current = limiterFor(built.service, { keys: holding([1, 2], 2) });
    const key = freshKey('asymmetric');
    expect((await admitMany(current, STAFF_SIGNIN, key, 10)).allowed).toBe(10);

    const refusal = await old.admit(STAFF_SIGNIN, key).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(LimiterUnavailableError);
    expect((refusal as LimiterUnavailableError).cause).toBeInstanceOf(LimiterKeyVersionError);
    expect((refusal as LimiterUnavailableError).cause).toMatchObject({
      code: 'LIMITER_KEY_VERSION_INCOMPATIBLE',
      heldVersions: [1],
      liveVersionsUnheld: [2],
    });
    await expect(old.admit(STAFF_SIGNIN, freshKey('other'))).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
    expect(await rowCount()).toBe(10);
    // The instance that holds both versions still counts exactly.
    expect((await current.admit(STAFF_SIGNIN, key)).allowed).toBe(false);
    expect(JSON.stringify((refusal as LimiterUnavailableError).cause)).not.toContain(
      'example.test',
    );
  });

  /**
   * Holds the capacity lock from a session of the test, lets `contenders` queue behind it (each has by then decided on its key and
   * has inserted nothing: it is waiting for the lock, and `pg_locks` says so), looks at what each holds while it waits, and then
   * lets them go. Nothing here sleeps for a time: the test waits for the state it needs to see.
   */
  async function throughTheCapacityLock<T>(
    start: readonly (() => Promise<T>)[],
  ): Promise<{ readonly outcomes: T[]; readonly heldWhileWaiting: Map<number, number[]> }> {
    const queued = async (): Promise<number[]> =>
      (
        await observer.rows<{ pid: number }>(
          `select pid from pg_locks where locktype = 'advisory' and classid = $1::oid and not granted`,
          [RATE_LIMIT_CAPACITY],
        )
      ).map((row) => row.pid);
    const heldWhileWaiting = new Map<number, number[]>();
    return withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1::int4, 0)', [RATE_LIMIT_CAPACITY]);
      // The contenders start only now, with the lock held, so that none can get past it before the test is looking.
      const contenders = start.map((begin) => begin());
      try {
        const deadline = Date.now() + 10_000;
        let waiting = await queued();
        while (waiting.length < contenders.length && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          waiting = await queued();
        }
        expect(waiting).toHaveLength(contenders.length);
        for (const pid of waiting) {
          const held = await observer.rows<{ classid: number; granted: boolean }>(
            `select classid::bigint::int as classid, granted from pg_locks
              where locktype = 'advisory' and pid = $1`,
            [pid],
          );
          // While it waits for the capacity lock, an admission holds its key locks and waits for nothing else.
          expect(held.filter((lock) => !lock.granted).map((lock) => lock.classid)).toEqual([
            RATE_LIMIT_CAPACITY,
          ]);
          heldWhileWaiting.set(
            pid,
            held.filter((lock) => lock.granted).map((lock) => lock.classid),
          );
        }
        expect(await rowCount()).toBe(0);
      } finally {
        await client.query('rollback');
      }
      return { outcomes: await Promise.all(contenders), heldWhileWaiting };
    });
  }

  // Break caught (the race): the compatibility check made before the capacity lock and not again under it, so that two instances
  // which share no digest lock (one holds version 1, the other version 2) each find the table clear and the key unused, queue for the
  // capacity lock, and insert one after the other: a limit of one admitted twice. The state is an incompatible rollout, and the guard
  // that claims to fail closed in exactly such states has to hold under the lock the insert is made under.
  it('admits at most one request when two instances that share no digest lock reach the capacity lock together, and fails the other closed', async () => {
    const first = limiterFor(built.service, { keys: holding([1], 1) });
    const second = limiterFor(built.service, { keys: holding([2], 2) });
    const key = freshKey('disjoint');
    await admin.query("update setting set value = '1' where key = 'rate_limit_staff_signin'");
    try {
      const { outcomes, heldWhileWaiting } = await throughTheCapacityLock([
        () => first.admit(STAFF_SIGNIN, key).catch((error: unknown) => error),
        () => second.admit(STAFF_SIGNIN, key).catch((error: unknown) => error),
      ]);

      const admitted = outcomes.filter(
        (outcome) =>
          typeof outcome === 'object' &&
          outcome !== null &&
          'allowed' in outcome &&
          outcome.allowed,
      );
      const refused = outcomes.filter((outcome) => outcome instanceof LimiterUnavailableError);
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.cause).toBeInstanceOf(LimiterKeyVersionError);
      // exactly one row: the incompatible contender wrote no admission
      expect(await rowCount()).toBe(1);
      // the two held different key locks (nothing shared to exclude them) while they waited
      expect([...heldWhileWaiting.values()]).toEqual([[RATE_LIMIT_KEY], [RATE_LIMIT_KEY]]);
    } finally {
      await admin.query("update setting set value = '10' where key = 'rate_limit_staff_signin'");
    }
  });

  // Break caught: the repair breaking what is compatible. Two instances that hold both versions and write under different ones share
  // a digest lock and so cannot interleave; with a limit of one they still admit exactly one, and neither is refused.
  it('still admits exactly one request when instances that hold both versions, and write under different ones, arrive together', async () => {
    const first = limiterFor(built.service, { keys: holding([1, 2], 1) });
    const second = limiterFor(built.service, { keys: holding([1, 2], 2) });
    const key = freshKey('compatible');
    await admin.query("update setting set value = '1' where key = 'rate_limit_staff_signin'");
    try {
      const decisions = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 === 0 ? first : second).admit(STAFF_SIGNIN, key),
        ),
      );

      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
      expect(await rowCount()).toBe(1);
    } finally {
      await admin.query("update setting set value = '10' where key = 'rate_limit_staff_signin'");
    }
  });

  // Break caught: an ordinary admission queued behind the capacity lock losing its place in the bound, or a key lock taken after the
  // capacity lock. Contenders with different keys and compatible versions queue together; at a capacity of three exactly three get in,
  // and each waits holding its key locks and for nothing else (a cycle would show as a deadlock the server breaks, error 40P01).
  it('keeps ordinary capacity contention exact, with the key locks taken before the capacity lock and none after', async () => {
    const first = limiterFor(built.service, { keys: holding([1, 2], 1), maxTotalRows: 3 });
    const second = limiterFor(built.service, { keys: holding([1, 2], 2), maxTotalRows: 3 });

    const { outcomes, heldWhileWaiting } = await throughTheCapacityLock(
      Array.from(
        { length: 6 },
        (_, index) => () =>
          (index % 2 === 0 ? first : second)
            .admit(STAFF_SIGNIN, freshKey(`queued-${String(index)}`))
            .catch((error: unknown) => error),
      ),
    );

    const decisions = outcomes.filter(
      (outcome): outcome is { allowed: boolean } =>
        typeof outcome === 'object' && outcome !== null && 'allowed' in outcome,
    );
    expect(decisions).toHaveLength(6);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(await rowCount()).toBe(3);
    // each held both versions' key locks (two of them: one for each version it holds) while it waited
    for (const classes of heldWhileWaiting.values()) {
      expect(classes).toEqual([RATE_LIMIT_KEY, RATE_LIMIT_KEY]);
    }
  });

  // Break caught: a version retired while rows under it still count, which would reset every allowance that rests on them.
  it('refuses an instance that retired a version while rows under it are live, and admits again once they have left the window', async () => {
    const writer = limiterFor(built.service, { keys: holding([1, 2], 1) });
    const key = freshKey('retire');
    await admitMany(writer, STAFF_SIGNIN, key, 4);
    const retired = limiterFor(built.service, { keys: holding([2], 2) });

    await expect(retired.admit(STAFF_SIGNIN, key)).rejects.toBeInstanceOf(LimiterUnavailableError);
    expect(await rowCount()).toBe(4);

    await admin.query(
      `update rate_limit_admission set admitted_at = admitted_at - interval '2 minutes'`,
    );
    expect((await retired.admit(STAFF_SIGNIN, key)).allowed).toBe(true);
  });

  // Break caught: a check that looks only below and above the versions an instance holds, and so misses a live version that sits
  // between two it holds (versions 1 and 3 held, version 2 written by another instance).
  it('refuses an instance that holds versions either side of a live one it does not hold', async () => {
    const writer = limiterFor(built.service, { keys: holding([1, 2, 3], 2) });
    const key = freshKey('between');
    await admitMany(writer, STAFF_SIGNIN, key, 3);
    const gapped = limiterFor(built.service, { keys: holding([1, 3], 3) });

    const refusal = await gapped.admit(STAFF_SIGNIN, key).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(LimiterUnavailableError);
    expect((refusal as LimiterUnavailableError).cause).toMatchObject({
      heldVersions: [1, 3],
      liveVersionsUnheld: [2],
    });
    expect(await rowCount()).toBe(3);
  });

  // Break caught: the refusal missing from the counters, so that a rotation that was done in the wrong order is invisible until a
  // person is locked out of signing in.
  it('counts each refusal, with no label and no identifier', async () => {
    const metrics = new BoundedMetrics({ policy: 'throw', clock });
    const old = limiterFor(built.service, { keys: holding([1], 1), metrics });
    await admitMany(
      limiterFor(built.service, { keys: holding([1, 2], 2) }),
      STAFF_SIGNIN,
      freshKey('c'),
      2,
    );

    await old.admit(STAFF_SIGNIN, freshKey('counted')).catch(() => undefined);
    await old.admit('rate_limit_recovery', freshKey('counted')).catch(() => undefined);

    const counted = metrics
      .snapshot()
      .counters.filter((entry) => entry.name === 'rate_limiter_key_incompatible_total');
    expect(counted).toEqual([
      { name: 'rate_limiter_key_incompatible_total', labels: {}, value: 2 },
    ]);
  });
});

describe('the check on key versions is an index probe, not a scan (G2-04)', () => {
  // Break caught: the version index missing or unusable, so that every admission scans the live rows to find that none is under a
  // version it does not hold. The plan is taken as the limiter's own capability, at a size (the capacity) where a scan would cost
  // twenty thousand rows; the planner is left to choose.
  it('reaches the version ranges through the version index at the table’s capacity', async () => {
    await admin.query(
      `insert into rate_limit_admission (bucket, key_digest, digest_version, admitted_at)
       select 'rate_limit_authenticated_api', decode(lpad(to_hex(g), 64, '0'), 'hex'), 1,
              clock_timestamp() - make_interval(secs => (g % 50))
         from generate_series(1, 20000) as g`,
    );
    await admin.query('analyze rate_limit_admission');
    const statement = liveVersionsNotHeldStatement([1, 3]);
    if (statement === undefined) throw new Error('a statement was expected');

    const plan = await withHandle(
      built.service,
      systemContext('rate_limit'),
      async (_handle, tx) => {
        const result = await tx.execute(sql`explain (analyze, buffers, format json) ${statement}`);
        const row = result.rows[0];
        return row?.['QUERY PLAN'] as readonly { Plan: PlanNode }[];
      },
    );

    const nodes = flatten(plan[0]?.Plan);
    const text = JSON.stringify(plan);
    expect(text).toContain('rate_limit_admission_version_idx');
    expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan')).toEqual([]);
    expect(
      nodes.find((node) => node['Index Name'] === 'rate_limit_admission_version_idx'),
    ).toBeDefined();
    // a probe of a btree touches a handful of pages; a scan of twenty thousand live rows touches hundreds
    const root = plan[0]?.Plan;
    const buffers =
      Number(root?.['Shared Hit Blocks'] ?? 0) + Number(root?.['Shared Read Blocks'] ?? 0);
    expect(buffers).toBeLessThan(60);
  });
});

interface PlanNode {
  readonly [key: string]: unknown;
  readonly Plans?: readonly PlanNode[];
}
function flatten(node: PlanNode | undefined): PlanNode[] {
  return node === undefined ? [] : [node, ...(node.Plans ?? []).flatMap(flatten)];
}

describe('the table’s capacity is a strict bound (G2-05)', () => {
  let other: BuiltService;
  beforeAll(() => {
    other = buildService(database, { poolMax: 8 });
  });
  afterAll(async () => {
    await other.close();
  });
  const distinct = (count: number, label: string) =>
    Array.from({ length: count }, () => freshKey(label));

  // Break caught (the defect): capacity judged on the rows already committed, so that distinct keys arriving together each see room
  // and the table ends above its bound. Two independent connection pools stand for two processes: they share the database and nothing
  // else.
  it.each([5, 12])(
    'admits exactly the capacity when distinct keys arrive together through two pools (capacity %i)',
    async (capacity) => {
      const limiters = [
        limiterFor(built.service, { maxTotalRows: capacity }),
        limiterFor(other.service, { maxTotalRows: capacity }),
      ];

      const decisions = await Promise.all(
        distinct(30, 'flood').map((key, index) =>
          (limiters[index % 2] ?? never()).admit(STAFF_SIGNIN, key),
        ),
      );

      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(capacity);
      expect(await rowCount()).toBe(capacity);
      for (const decision of decisions) {
        if (!decision.allowed) expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    },
  );

  // Break caught: a place taken by an admission that did not commit staying taken, or a refusal for want of room that rolling back
  // would have cured. Nothing is counted outside the rows, so there is nothing to leak.
  it('gives the place back when the admission does not commit', async () => {
    const limiter = limiterFor(built.service, { maxTotalRows: 3 });
    const losing = limiterFor(
      {
        transactionWithContext: (context: never, work: (tx: never) => Promise<unknown>) =>
          built.service.transactionWithContext(context, async (tx) => {
            await work(tx as never);
            throw new Error('the commit was lost');
          }),
      } as never,
      { maxTotalRows: 3 },
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(losing.admit(STAFF_SIGNIN, freshKey('lost'))).rejects.toBeInstanceOf(
        LimiterUnavailableError,
      );
    }
    expect(await rowCount()).toBe(0);

    const { allowed } = await alternateDistinct(limiter, 5);
    expect(allowed).toBe(3);
  });

  async function alternateDistinct(limiter: PostgresRateLimiter, times: number) {
    let allowed = 0;
    for (const key of distinct(times, 'after')) {
      if ((await limiter.admit(STAFF_SIGNIN, key)).allowed) allowed += 1;
    }
    return { allowed };
  }

  // Break caught: expired rows that have not been cleaned not counting toward the bound (so the table is larger than its capacity
  // says), or counting and never being reclaimed (so a full table of expired rows refuses everyone for ever). The batch is one row,
  // so each admission can make room for one admission and no more: the bound holds at every step, and the backlog is replaced.
  it('counts expired rows that are still there, and reclaims a bounded number of them to make room', async () => {
    const limiter = limiterFor(built.service, { maxTotalRows: 5, cleanupBatch: 1 });
    await admin.query(
      `insert into rate_limit_admission (bucket, key_digest, digest_version, admitted_at)
       select 'rate_limit_authenticated_api', decode(lpad(to_hex(g), 64, '0'), 'hex'), 1, clock_timestamp() - interval '2 minutes'
         from generate_series(1, 5) as g`,
    );

    const outcome: boolean[] = [];
    for (const key of distinct(6, 'backlog')) {
      outcome.push((await limiter.admit(STAFF_SIGNIN, key)).allowed);
      // never more than the bound, whatever mixture of live and expired rows there is
      expect(await rowCount()).toBeLessThanOrEqual(5);
    }

    // Five expired rows are replaced by five live ones, one at a time, and the sixth meets a full table of live rows.
    expect(outcome).toEqual([true, true, true, true, true, false]);
    expect(await rowCount()).toBe(5);
    expect(await observer.count('rate_limit_admission', { bucket: STAFF_SIGNIN })).toBe(5);
  });

  // Break caught: a bound judged on live rows alone, which lets an expired backlog stand above the capacity for as long as the
  // cleanup takes (here the capacity was lowered under a table that holds more than it, which is how a backlog can exceed it). The
  // bound is on the rows retained: nobody is admitted until the backlog has been reclaimed to below it, a batch for each attempt.
  it('refuses uniformly while an expired backlog stands at or above the capacity, and admits once it is reclaimed below it', async () => {
    const limiter = limiterFor(built.service, { maxTotalRows: 5, cleanupBatch: 1 });
    await admin.query(
      `insert into rate_limit_admission (bucket, key_digest, digest_version, admitted_at)
       select 'rate_limit_authenticated_api', decode(lpad(to_hex(g), 64, '0'), 'hex'), 1, clock_timestamp() - interval '2 minutes'
         from generate_series(1, 8) as g`,
    );

    const outcome: boolean[] = [];
    for (const key of distinct(5, 'draining')) {
      outcome.push((await limiter.admit(STAFF_SIGNIN, key)).allowed);
    }

    // 8 rows and a batch of one: 7, 6 and 5 retained are not below 5, so the first three attempts are refused (each reclaiming one);
    // the fourth finds 4 and admits, the fifth reclaims one more and admits: five rows, three of them still expired.
    expect(outcome).toEqual([false, false, false, true, true]);
    expect(await rowCount()).toBe(5);
  });

  // Break caught: a bound that holds only because the table was never given more than it could hold: the cleanup is the one that
  // removes expired rows, and only a transaction holding the capacity lock deletes.
  it('never lets a refused admission leave more rows than it found', async () => {
    const limiter = limiterFor(built.service, { maxTotalRows: 3 });
    await admitMany(limiter, STAFF_SIGNIN, freshKey('a'), 1);
    await admitMany(limiter, STAFF_SIGNIN, freshKey('b'), 1);
    await admitMany(limiter, STAFF_SIGNIN, freshKey('c'), 1);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await limiter.admit(STAFF_SIGNIN, freshKey('over'))).allowed).toBe(false);
      expect(await rowCount()).toBe(3);
    }
  });

  // Break caught: a batch that is not bounded (a sweep inside a request), or a cleanup that removes a row that still counts.
  it('removes at most a batch of expired rows in an admission, the oldest first, and never a live one', async () => {
    const limiter = limiterFor(built.service, { cleanupBatch: 3 });
    await admin.query(
      `insert into rate_limit_admission (bucket, key_digest, digest_version, admitted_at)
       select 'rate_limit_authenticated_api', decode(lpad(to_hex(g), 64, '0'), 'hex'), 1,
              clock_timestamp() - interval '2 minutes' + make_interval(secs => g)
         from generate_series(1, 10) as g`,
    );
    await admin.query(
      `insert into rate_limit_admission (bucket, key_digest, digest_version)
       values ('rate_limit_recovery', decode(repeat('ee', 32), 'hex'), 1)`,
    );

    await limiter.admit(STAFF_SIGNIN, freshKey('batch'));

    // three of the ten expired rows gone (the oldest), seven expired and two live ones remain
    expect(await rowCount()).toBe(11 - 3 + 1);
    const oldest = await observer.one<{ n: number }>(
      `select count(*)::int as n from rate_limit_admission
        where admitted_at < clock_timestamp() - interval '60 seconds'
          and key_digest in (decode(lpad(to_hex(1), 64, '0'), 'hex'), decode(lpad(to_hex(2), 64, '0'), 'hex'),
                             decode(lpad(to_hex(3), 64, '0'), 'hex'))`,
    );
    expect(oldest?.n).toBe(0);
  });

  // Break caught (G2-05): every admission that writes waiting for the capacity lock is the cost of the strict bound; a refusal at a
  // bucket's ceiling waiting for it would put the cost on the callers who write nothing. Only admissions that would write queue.
  it('makes only an admission that would write wait for the capacity lock, and never a refusal at a ceiling', async () => {
    const limiter = limiterFor();
    const full = freshKey('full');
    await admitMany(limiter, STAFF_SIGNIN, full, 10);

    const result = await withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1::int4, 0)', [RATE_LIMIT_CAPACITY]);
      let waiting: Promise<unknown> | undefined;
      try {
        const refused = await limiter.admit(STAFF_SIGNIN, full);
        waiting = limiter.admit(STAFF_SIGNIN, freshKey('writes'));
        const state = await Promise.race([
          waiting.then(() => 'answered'),
          new Promise<'waited'>((resolveWait) => {
            setTimeout(() => {
              resolveWait('waited');
            }, 800);
          }),
        ]);
        return { refused, state };
      } finally {
        await client.query('rollback');
        await waiting?.catch(() => undefined);
      }
    });

    expect(result.refused.allowed).toBe(false);
    expect(result.state).toBe('waited');
    expect(await rowCount()).toBe(11);
  });

  // Break caught: a flood of invented identifiers evicting a victim’s live rows to make room, in any mixture of processes.
  it('keeps a victim’s live rows through a concurrent flood at capacity', async () => {
    const limiters = [
      limiterFor(built.service, { maxTotalRows: 6 }),
      limiterFor(other.service, { maxTotalRows: 6 }),
    ];
    const victim = freshKey('victim');
    await admitMany(limiters[0] ?? never(), STAFF_SIGNIN, victim, 3);

    await Promise.all(
      distinct(40, 'invented').map((key, index) =>
        (limiters[index % 2] ?? never()).admit(STAFF_SIGNIN, key),
      ),
    );

    expect(await rowCount()).toBe(6);
    // The victim’s three rows stand: it is at its own count of three, not evicted, and the table is full so it is refused uniformly.
    const victimDigest = new LimiterDigest(KEYS).digestsFor(STAFF_SIGNIN, victim).active.bytes;
    const rows = await observer.one<{ n: number }>(
      'select count(*)::int as n from rate_limit_admission where key_digest = $1',
      [victimDigest],
    );
    expect(rows?.n).toBe(3);
    expect((await (limiters[0] ?? never()).admit(STAFF_SIGNIN, victim)).allowed).toBe(false);
  });
});
