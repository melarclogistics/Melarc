import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireBuild } from '../support/api-process.js';
import { openAdmin, type Admin } from './support/admin.js';
import { observe, type Observer } from './support/observe.js';
import { seedReferenceData } from './support/seeded.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.14: the limiter admits no more than its ceiling across two processes (obligation OB-16, `GBT-O` and SECURITY_DESIGN.md §14.12:
 * "Two API processes sharing the same buckets; persistence across a restart; the exact threshold under concurrent admission").
 * Two separate Node processes, each composing the real limiter from the built output over one real database as the runtime login,
 * admit to one bucket and one key at the same moment; the database decides, and the total is the limit exactly. The processes
 * run `test/support/limiter-child.mjs`, which is never built into dist.
 */

const CHILD = resolve(import.meta.dirname, '../support/limiter-child.mjs');

interface ChildResult {
  allowed: number;
  refused: number;
  errors: string[];
  startedAt: number;
  endedAt: number;
}

let database: TestDatabase;
let admin: Admin;
let observer: Observer;
const limiterKey = randomBytes(32).toString('base64url');

beforeAll(async () => {
  requireBuild();
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = await openAdmin(database);
  observer = await observe(database);
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await database.drop();
});

function runChild(options: {
  bucket: string;
  key: string;
  attempts: number;
  concurrency: number;
  startAt: number;
}): Promise<ChildResult> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [CHILD], {
      // Only what the child needs, plus what Windows needs before Node will start its crypto (an empty value is worse than none).
      env: {
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        DATABASE_URL: database.urlFor('melarc_api_runtime'),
        LIMITER_KEY: limiterKey,
        BUCKET: options.bucket,
        KEY: options.key,
        ATTEMPTS: String(options.attempts),
        CONCURRENCY: String(options.concurrency),
        START_AT: String(options.startAt),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', rejectChild);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectChild(new Error(`the limiter process exited ${String(code)}: ${err.slice(0, 2000)}`));
        return;
      }
      try {
        resolveChild(JSON.parse(out.trim().split('\n').at(-1) ?? '') as ChildResult);
      } catch {
        rejectChild(
          new Error(`the limiter process printed nothing readable: ${out.slice(0, 500)}`),
        );
      }
    });
  });
}

describe('two processes against one database', () => {
  // Break caught: each process counting on its own, so that two instances admit twice the ceiling; or decisions that are not
  // serialised per key, so that two admissions at the same moment both see room.
  it('admit exactly the ceiling between them when they ask at the same moment', async () => {
    const startAt = Date.now() + 4_000;
    const ask = {
      bucket: 'rate_limit_staff_signin',
      key: 'shared-key@example.test',
      attempts: 30,
      concurrency: 5,
      startAt,
    };

    const [first, second] = await Promise.all([runChild(ask), runChild(ask)]);

    // The ceiling of the staff sign-in bucket is ten a minute (settings.md §7.7); sixty were asked for.
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(first.allowed + second.allowed).toBe(10);
    expect(first.refused + second.refused).toBe(50);
    const rows = await observer.count('rate_limit_admission', { bucket: ask.bucket });
    expect(rows).toBe(10);
    // They really did overlap: neither finished before the other began.
    expect(first.startedAt).toBeLessThan(second.endedAt);
    expect(second.startedAt).toBeLessThan(first.endedAt);
  }, 60_000);

  // Break caught: state held in a process (a restart resetting an allowance), or the second process not seeing the first's rows.
  it('keep the allowance across processes that start later: nothing is held in memory', async () => {
    const key = 'persistent@example.test';
    const common = { bucket: 'rate_limit_recovery', key, concurrency: 3, startAt: Date.now() };

    const early = await runChild({ ...common, attempts: 7 });
    const later = await runChild({ ...common, attempts: 7, startAt: Date.now() });

    // Ten a minute: the first process takes seven, a process started afterwards is given the three that remain.
    expect(early.allowed).toBe(7);
    expect(later.allowed).toBe(3);
    expect(later.refused).toBe(4);
    expect(await observer.count('rate_limit_admission', { bucket: 'rate_limit_recovery' })).toBe(
      10,
    );
  }, 60_000);
});
