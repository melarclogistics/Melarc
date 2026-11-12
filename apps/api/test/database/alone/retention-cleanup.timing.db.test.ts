// Runs alone: it bounds a cleanup that must not wait behind a lock at 1.5 seconds of wall-clock time.
// Functional half, which runs on a pull request: retention-cleanup.db.test.ts (the other tests of the cleanup, which assert no time; task CI.2, run 4 Stage 1 item 5).
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { API_RUNTIME_ROLE } from '../../../src/platform/config/load-config.js';
import { WORKER_RUNTIME_ROLE } from '../../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../../src/platform/database/transaction-context.js';
import { PostgresDeliveryQueue } from '../../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { RetentionCleanup } from '../../../src/platform/delivery/retention/retention-cleanup.js';
import { localKeys } from '../../../src/test-support/key-config.js';
import { openAdmin, type Admin } from '../support/admin.js';
import { withHandle } from '../support/handle.js';
import { observe, type Observer } from '../support/observe.js';
import { PRINCIPAL_1, systemContext } from '../support/rls-fixture.js';
import { buildService, type BuiltService } from '../support/service.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * S0.19 against a real PostgreSQL: the retention cleanup of the delivery worker. It erases credential material whose time has
 * passed, under the `credential_delivery` capability as `melarc_worker_runtime`: the payload of a message whose redemption record has
 * ended, and the sealed replay of an idempotency record whose window has closed. **It deletes nothing**: no identity holds `DELETE`
 * on either table (data-scope registry §5.2), and the retention of a finished job's metadata is unset (OQ-028).
 */

const clock = new SystemClock();
const ISSUER: SecurityContext = systemContext('authentication');
const cipher = new AesGcmSecretCipher(localKeys());

let database: TestDatabase;
let api: BuiltService;
let work: BuiltService;
let admin: Admin;
let observer: Observer;
let queue: PostgresDeliveryQueue;

beforeAll(async () => {
  database = await createTestDatabase();
  api = buildService(database, { poolMax: 4 });
  work = buildService(database, { poolMax: 6, login: WORKER_RUNTIME_ROLE });
  admin = await openAdmin(database);
  observer = await observe(database);
  await admin.query(`create table public.delivery_fixture_redemption (
      id uuid primary key, state text not null, expires_at timestamptz not null)`);
  await admin.query('alter table public.delivery_fixture_redemption owner to melarc_owner');
  await admin.query(
    `grant select, insert, update on public.delivery_fixture_redemption to ${API_RUNTIME_ROLE}`,
  );
  queue = new PostgresDeliveryQueue({ cipher, clock, work: work.service });
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await api.close();
  await work.close();
  await database.drop();
});

beforeEach(async () => {
  await arrange('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
  await admin.query('delete from idempotency_record');
});

const cleanup = (batchSize?: number) =>
  new RetentionCleanup({
    database: work.service,
    clock,
    ...(batchSize === undefined ? {} : { batchSize }),
  });

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

/** Queues a message as an issuing operation does, with the end of its record `minutes` from now (negative: already past). */
async function issue(
  minutes = 30,
): Promise<{ readonly id: string; readonly redemptionId: string }> {
  const redemptionId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const job = await withHandle(api.service, ISSUER, async (handle, tx) => {
    await tx.execute(
      sql`insert into delivery_fixture_redemption (id, state, expires_at)
          values (${redemptionId}, 'PENDING', ${expiresAt.toISOString()}::timestamptz)`,
    );
    return queue.enqueue(handle, {
      kind: 'SETUP_GRANT',
      redemption: { type: 'SETUP_GRANT', id: redemptionId },
      principal: { type: 'STAFF', id: PRINCIPAL_1 },
      channel: 'EMAIL',
      destination: 'retention.recipient@example.test',
      link: 'https://ops.example.test/setup/credential#token=SENTINEL-RETENTION-TOKEN',
      expiresAt,
    });
  });
  if (minutes < 0) await overdue(job.id, minutes);
  return { id: job.id, redemptionId };
}

/** Moves a job's end into the past (and its making before that), as time passing would. */
const overdue = (id: string, minutes = -1) =>
  arrange(
    `update credential_delivery_job
        set expires_at = clock_timestamp() + ($2::int * interval '1 minute'),
            created_at = clock_timestamp() + ($2::int * interval '1 minute') - interval '1 second'
      where id = $1`,
    [id, minutes],
  );

interface Row {
  readonly state: string;
  readonly outcome_class: string | null;
  readonly payload_ciphertext: Buffer | null;
  readonly payload_erased_at: Date | null;
  readonly lease_owner: string | null;
}
const rowOf = async (id: string): Promise<Row> => {
  const row = await observer.one<Row>('select * from credential_delivery_job where id = $1', [id]);
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
};

describe('the retention cleanup of delivery jobs (S0.19)', () => {
  // Break caught: a cleanup that waits for a row another transaction holds locked (a worker marking it, or another cleanup), where it
  // should leave that row and take the next: it takes none of anyone's locks for longer than its own statement.
  it('does not wait for a job another transaction holds locked, and takes the next', async () => {
    const locked = await issue(-10);
    const other = await issue(-5);
    const holder = await openAdmin(database);
    try {
      await holder.query('begin');
      await holder.query('select id from credential_delivery_job where id = $1 for update', [
        locked.id,
      ]);

      const started = Date.now();
      const report = await cleanup(1).runOnce();

      expect(report.jobsExpired).toBe(1);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect((await rowOf(other.id)).state).toBe('EXPIRED');
      expect((await rowOf(locked.id)).state).toBe('QUEUED');
      await holder.query('rollback');
    } finally {
      await holder.close();
    }
  });
});
