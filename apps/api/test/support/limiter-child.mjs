// A test-only entry point for the two-process proof of the rate limiter (S0.14). It is never built into dist and nothing in src/
// refers to it. It composes the real limiter from the built output, over a real database, as the API's runtime login, makes a
// number of admissions to one bucket and key with a few in flight at a time, and prints one JSON line with what it was told.
// Two of these run at once against one database, which is what "shared by every instance" has to survive.
//
// usage: node limiter-child.mjs          (everything comes from the environment; nothing is printed but the one result line)
//   DATABASE_URL     the runtime login's URL
//   LIMITER_KEY      the limiter digest key, base64url of 32 bytes: both processes must hold the same
//   BUCKET, KEY      the bucket and the canonical key to admit
//   ATTEMPTS         how many admissions to make
//   CONCURRENCY      how many may be in flight at once
//   START_AT         epoch milliseconds to wait for before the first admission, so that two processes begin together
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { SystemClock } from '../../dist/platform/auth/clock/system.clock.adapter.js';
import { LimiterDigest } from '../../dist/platform/auth/crypto/limiter-digest.js';
import { INERT_DEADLINES } from '../../dist/platform/config/inert-config.js';
import { Secret } from '../../dist/platform/config/secret.js';
import { createPool } from '../../dist/platform/database/database.module.js';
import { DatabaseService } from '../../dist/platform/database/database.service.js';
import { postgresConnectionSettings } from '../../dist/platform/database/postgres-url.js';
import { PgStatementCanceller } from '../../dist/platform/database/statement-canceller.js';
import { bindTransactionHandle } from '../../dist/platform/database/transaction-handle.js';
import { DISPOSAL_BOUND_MS } from '../../dist/platform/execution/execution-parameters.js';
import { ReadinessRegistry } from '../../dist/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../dist/platform/lifecycle/shutdown.registry.js';
import { SettingsBucketLimits } from '../../dist/platform/limiter/bucket-limits.js';
import { PostgresRateLimiter } from '../../dist/platform/limiter/postgres.rate-limiter.adapter.js';
import { SettingsReader } from '../../dist/platform/settings/settings-reader.js';

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
};

const url = env('DATABASE_URL');
const clock = new SystemClock();
const noop = () => undefined;
const quiet = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => quiet,
};
const shutdown = new ShutdownRegistry();
const poolMax = 6;
const service = new DatabaseService(
  createPool({ url, poolMax, deadlines: INERT_DEADLINES }),
  quiet,
  shutdown,
  new ReadinessRegistry(),
  {
    clock,
    poolMax,
    deadlines: INERT_DEADLINES,
    canceller: new PgStatementCanceller(postgresConnectionSettings(url), {
      timeoutMilliseconds: DISPOSAL_BOUND_MS,
      clock,
    }),
  },
);

const limiterContext = {
  principalType: 'SYSTEM',
  principalId: '66666666-6666-4666-8666-666666666666',
  surface: 'SYSTEM',
  taskCapability: 'rate_limit',
  correlationId: 'limiter-child',
};
const limiter = new PostgresRateLimiter({
  database: service,
  digest: new LimiterDigest({
    custody: 'local',
    purposes: {
      limiter_digest: { activeVersion: 1, versions: { 1: new Secret(env('LIMITER_KEY')) } },
    },
  }),
  limits: new SettingsBucketLimits(new SettingsReader()),
  clock,
});

const bucket = env('BUCKET');
const key = env('KEY');
const attempts = Number(env('ATTEMPTS'));
const concurrency = Number(env('CONCURRENCY'));
const startAt = Number(env('START_AT'));

const result = { allowed: 0, refused: 0, errors: [], startedAt: 0, endedAt: 0 };
try {
  // Connect and read the limit once before the start, so that the first admissions of the two processes meet.
  await service.transactionWithContext(limiterContext, (tx) =>
    new SettingsBucketLimits(new SettingsReader()).limitOf(bucket, bindTransactionHandle(tx)),
  );
  const wait = startAt - Date.now();
  if (wait > 0) await sleep(wait);

  result.startedAt = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < attempts) {
      next += 1;
      try {
        const decision = await limiter.admit(bucket, key);
        if (decision.allowed) result.allowed += 1;
        else result.refused += 1;
      } catch (error) {
        result.errors.push(error?.code ?? error?.name ?? 'error');
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  result.endedAt = Date.now();
} finally {
  await shutdown.closeAll();
}
process.stdout.write(`${JSON.stringify(result)}\n`);
