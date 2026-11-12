// Runs alone: it bounds a claim that must not wait behind a lock at 1.5 seconds of wall-clock time.
// Functional half, which runs on a pull request: credential-delivery-job.db.test.ts (the other tests of the claim, which assert no time; task CI.2, run 4 Stage 1 item 5).
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AesGcmSecretCipher } from '../../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import type {
  DeliveryJobRef,
  DeliveryRequest,
} from '../../../src/platform/auth/ports/delivery-queue.port.js';
import { API_RUNTIME_ROLE } from '../../../src/platform/config/load-config.js';
import { WORKER_RUNTIME_ROLE } from '../../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../../src/platform/database/transaction-context.js';
import { PostgresDeliveryQueue } from '../../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { localKeys } from '../../../src/test-support/key-config.js';
import { ManualClock } from '../../../src/test-support/manual-clock.js';
import { openAdmin, type Admin } from '../support/admin.js';
import { withHandle } from '../support/handle.js';
import { observe, type Observer } from '../support/observe.js';
import { PRINCIPAL_1, systemContext } from '../support/rls-fixture.js';
import { buildService, type BuiltService } from '../support/service.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * S0.17 against a real PostgreSQL: the durable credential-delivery job (`credential_delivery_job`, migration 0009) and the queue
 * over it, as `melarc_api_runtime` for the issuing side (a `SYSTEM` context under `authentication`) and `melarc_worker_runtime`
 * for the worker side (under `credential_delivery`, through the capability role it is given). State machine: state-machines.md
 * §22; SECURITY_DESIGN.md §13.9a. The redemption record is a stand-in table, because the real `setup_grant` and `recovery_request`
 * arrive in S0.29 and S0.50: it has what the job needs of one (an identity, a state and an end).
 *
 * The worker process, its schedule of retries and its shutdown are S0.18's, and the cleanup of material that has ended is S0.19's.
 */

const clock = new ManualClock(new Date('2026-10-10T08:00:00.000Z'));
const SENTINEL_TOKEN = 'SENTINEL-DELIVERY-TOKEN-7c41f0a2b9d3e8156a04c7b2d9e3f1a8';
const SENTINEL_DESTINATION = 'sentinel.recipient@example.test';

let database: TestDatabase;
let api: BuiltService;
let work: BuiltService;
let admin: Admin;
let observer: Observer;
let queue: PostgresDeliveryQueue;
const cipher = new AesGcmSecretCipher(localKeys());

const ISSUER: SecurityContext = systemContext('authentication');

beforeAll(async () => {
  database = await createTestDatabase();
  api = buildService(database, { poolMax: 4 });
  work = buildService(database, { poolMax: 4, login: WORKER_RUNTIME_ROLE });
  admin = await openAdmin(database);
  observer = await observe(database);
  // The stand-in redemption record: an identity, a state and an end. The API writes it in the issuing transaction, as it will
  // write a setup grant; the job holds no reference to it, so nothing here can change it.
  await admin.query(`create table public.delivery_fixture_redemption (
      id uuid primary key, state text not null, expires_at timestamptz not null)`);
  await admin.query('alter table public.delivery_fixture_redemption owner to melarc_owner');
  await admin.query(
    `grant select, insert, update on public.delivery_fixture_redemption to ${API_RUNTIME_ROLE}`,
  );
  queue = new PostgresDeliveryQueue({
    cipher,
    clock,
    work: work.service,
    random: () => 0.5,
  });
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await api.close();
  await work.close();
  await database.drop();
});

// A test that fails midway leaves jobs behind, and the next must not claim them: every test begins with the table empty.
beforeEach(async () => {
  await admin.query('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
});

const inMinutes = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

interface Issued {
  readonly redemptionId: string;
  readonly job: DeliveryJobRef;
  readonly request: DeliveryRequest;
}

function requestFor(over: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    kind: 'SETUP_GRANT',
    redemption: { type: 'SETUP_GRANT', id: randomUUID() },
    principal: { type: 'STAFF', id: PRINCIPAL_1 },
    channel: 'EMAIL',
    destination: SENTINEL_DESTINATION,
    link: `https://ops.example.test/setup/credential#token=${SENTINEL_TOKEN}`,
    expiresAt: inMinutes(30),
    ...over,
  };
}

/** What an issuing operation does: write the redemption record and queue its message in one transaction of the API. */
async function issue(over: Partial<DeliveryRequest> = {}): Promise<Issued> {
  const request = requestFor(over);
  const job = await withHandle(api.service, ISSUER, async (handle, tx) => {
    await tx.execute(
      sql`insert into delivery_fixture_redemption (id, state, expires_at)
          values (${request.redemption.id}, 'PENDING', ${request.expiresAt.toISOString()}::timestamptz)`,
    );
    return queue.enqueue(handle, request);
  });
  return { redemptionId: request.redemption.id, job, request };
}

/**
 * Arranges a state that no operation can reach by itself (an old lease, a past expiry) as the administrator does: the guard that
 * keeps the table honest is switched off for the one statement, and back on.
 */
async function arrange(statement: string, values: unknown[] = []): Promise<void> {
  await admin.query(
    'alter table credential_delivery_job disable trigger credential_delivery_job_guard',
  );
  try {
    await admin.query(statement, values);
  } finally {
    await admin.query(
      'alter table credential_delivery_job enable trigger credential_delivery_job_guard',
    );
  }
}

/** Leaves no job that could be claimed by a later test, whatever an earlier one made. */
async function clearJobs(): Promise<void> {
  await arrange('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
}

describe('the worker side: a claim, a lease and a fence', () => {
  // Break caught: a claim that waits for a job another worker is working on (a worker stalled behind another's transaction), where it
  // should leave that job and take the next one or none.
  it('does not wait for a job another transaction holds locked', async () => {
    const locked = await issue();
    const other = await issue();
    const holder = await openAdmin(database);
    try {
      // Another worker is part-way through claiming the older job: its row is locked in an open transaction.
      await holder.query('begin');
      await holder.query('select id from credential_delivery_job where id = $1 for update', [
        locked.job.id,
      ]);

      const started = Date.now();
      const claimed = await queue.claim('dw-nowait', 30_000);

      // It took the other job, at once, and did not queue behind the lock.
      expect(claimed?.job.id).toBe(other.job.id);
      expect(Date.now() - started).toBeLessThan(1_500);
      await holder.query('rollback');
    } finally {
      await holder.close();
    }
    await clearJobs();
  });
});
