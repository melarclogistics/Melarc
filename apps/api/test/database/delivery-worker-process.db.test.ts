import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { localKeys } from '../../src/test-support/key-config.js';
import {
  DEADLINES,
  killAll,
  requireBuild,
  start,
  WORKER_FIXTURE,
  type Finished,
} from '../support/api-process.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import { PRINCIPAL_1, systemContext } from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The delivery worker as a real process against a real database (S0.18; OB-24): a message in flight when the process is told to
 * stop is given back, and the process ends by itself with exit code 0. The process is the built worker composed by
 * `test/support/worker-process-fixture.mjs` with a provider that never answers and a reader that says every record is pending, so
 * that the job is claimed and its send is in flight at the moment of the stop. The fixture signals itself on the send, so this runs
 * on Windows as well; the same stop through a real SIGTERM runs on Linux and macOS and is skipped on Windows.
 */

const ISSUER: SecurityContext = systemContext('authentication');
const keys = localKeys();
const cipher = new AesGcmSecretCipher(keys);
const clock = new SystemClock();

let database: TestDatabase;
let api: BuiltService;
let work: BuiltService;
let admin: Admin;
let observer: Observer;
let queue: PostgresDeliveryQueue;
let sink: string;

beforeAll(async () => {
  requireBuild();
  database = await createTestDatabase();
  api = buildService(database, { poolMax: 2 });
  work = buildService(database, { poolMax: 2, login: WORKER_RUNTIME_ROLE });
  admin = await openAdmin(database);
  observer = await observe(database);
  await admin.query(`create table public.delivery_fixture_redemption (
      id uuid primary key, state text not null, expires_at timestamptz not null)`);
  await admin.query('alter table public.delivery_fixture_redemption owner to melarc_owner');
  await admin.query(
    `grant select, insert, update on public.delivery_fixture_redemption to ${API_RUNTIME_ROLE}`,
  );
  queue = new PostgresDeliveryQueue({ cipher, clock, work: work.service });
  sink = await mkdtemp(join(tmpdir(), 'melarc-worker-db-sink-'));
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await api.close();
  await work.close();
  await database.drop();
  await rm(sink, { recursive: true, force: true });
});

beforeEach(async () => {
  await admin.query('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
  await admin.query('delete from idempotency_record');
});

afterEach(killAll);

function workerEnvironment(): Record<string, string> {
  const delivery = keys.purposes.credential_delivery;
  const secret = delivery.versions[delivery.activeVersion]?.reveal();
  if (secret === undefined) throw new Error('the test keys hold no delivery key');
  return {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    DATABASE_WORKER_URL: database.urlFor(WORKER_RUNTIME_ROLE),
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: `${String(delivery.activeVersion)}:${secret}`,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: String(delivery.activeVersion),
    DELIVERY_CAPTURE_DIRECTORY: sink,
    DELIVERY_WORKER_POLL_INTERVAL_MS: '100',
    SHUTDOWN_TIMEOUT_MS: '5000',
  };
}

async function issue(): Promise<string> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const job = await withHandle(api.service, ISSUER, async (handle, tx) => {
    await tx.execute(
      sql`insert into delivery_fixture_redemption (id, state, expires_at)
          values (${id}, 'PENDING', ${expiresAt.toISOString()}::timestamptz)`,
    );
    return queue.enqueue(handle, {
      kind: 'SETUP_GRANT',
      redemption: { type: 'SETUP_GRANT', id },
      principal: { type: 'STAFF', id: PRINCIPAL_1 },
      channel: 'EMAIL',
      destination: 'process.recipient@example.test',
      link: 'https://ops.example.test/setup/credential#token=SENTINEL-PROCESS-TOKEN',
      expiresAt,
    });
  });
  return job.id;
}

const rowOf = (id: string) =>
  observer.one<{
    state: string;
    outcome_class: string | null;
    attempt_count: number;
    lease_owner: string | null;
    payload_ciphertext: Buffer | null;
  }>('select * from credential_delivery_job where id = $1', [id]);

async function until(condition: () => Promise<boolean> | boolean, what: string, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const said = (finished: Finished): unknown[] =>
  finished.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { msg: unknown }).msg);

describe('a worker process that erases expired credential material while it runs (S0.19)', () => {
  // Break caught: a retention cleanup that exists and is never run by the process, or that runs and leaves a live token in a job whose
  // record has ended, or a sealed replay past its window. The fixture runs the real composition with the cleanup every 150 ms.
  it('expires a job whose record ended and erases an expired sealed replay on its own, then stops by itself', async () => {
    const id = await issue();
    await admin.query(
      'alter table credential_delivery_job disable trigger credential_delivery_job_guard',
    );
    await admin.query(
      `update credential_delivery_job
          set expires_at = clock_timestamp() - interval '1 minute',
              created_at = clock_timestamp() - interval '2 minutes' where id = $1`,
      [id],
    );
    await admin.query(
      'alter table credential_delivery_job enable trigger credential_delivery_job_guard',
    );
    const replayId = randomUUID();
    await admin.query(
      `insert into idempotency_record
         (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state, completed_at, response_status,
          response_body, sealed_ciphertext, sealed_nonce, sealed_key_version, sealed_envelope_version, sealed_expires_at)
       values ($1, 'STAFF', $2, 'registerRiderDevice', $3, $4, 'COMPLETED', now(), 201, decode('7b7d', 'hex'),
          decode('aabbcc', 'hex'), decode('000102030405060708090a0b', 'hex'), 1, 1, now() - interval '1 minute')`,
      [replayId, PRINCIPAL_1, `key-${replayId}`, 'a'.repeat(64)],
    );
    const running = start(WORKER_FIXTURE, workerEnvironment(), [
      'plain',
      '--retention=150',
      '--signal-after=3000',
    ]);

    await until(
      async () =>
        (await rowOf(id))?.state === 'EXPIRED' &&
        (
          await observer.one<{ sealed_ciphertext: Buffer | null }>(
            'select sealed_ciphertext from idempotency_record where id = $1',
            [replayId],
          )
        )?.sealed_ciphertext === null,
      'the expired material to be erased',
    );
    const finished = await running.waitForExit(DEADLINES.stop, 'did not end by itself');

    expect(finished).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(await rowOf(id)).toMatchObject({
      state: 'EXPIRED',
      outcome_class: 'EXPIRED',
      payload_ciphertext: null,
    });
    expect(
      await observer.one<{ replay_unavailable_at: Date | null; response_status: number }>(
        'select replay_unavailable_at, response_status from idempotency_record where id = $1',
        [replayId],
      ),
    ).toMatchObject({ response_status: 201 });
    const erased = finished.stdout
      .split('\n')
      .filter((line) => line.includes('delivery retention erased expired material'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(erased.length).toBeGreaterThanOrEqual(1);
    expect(erased.reduce((sum, line) => sum + Number(line.jobs_expired ?? 0), 0)).toBe(1);
    expect(erased.reduce((sum, line) => sum + Number(line.replay_erased ?? 0), 0)).toBe(1);
    expect(finished.stdout).not.toContain('SENTINEL-PROCESS-TOKEN');
  });

  // Break caught (G2-03): the worker as composed, with no reader that can confirm a redemption record, claiming a live message anyway.
  // Every claim it made would be given back and each would count against the message, so a worker started before the readers exist
  // would spend the message's sends without one being possible. The job stays queued with no attempt counted, while the cleanup
  // that shares the process keeps running.
  it('leaves a live queued message unclaimed and unspent while its readers are not built, and still runs the cleanup', async () => {
    const id = await issue();
    const running = start(WORKER_FIXTURE, workerEnvironment(), [
      'plain',
      '--retention=100',
      '--signal-after=1500',
    ]);

    const finished = await running.waitForExit(DEADLINES.stop, 'did not end by itself');

    expect(finished).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(await rowOf(id)).toMatchObject({
      state: 'QUEUED',
      attempt_count: 0,
      lease_owner: null,
      outcome_class: null,
    });
    expect(await rowOf(id)).toHaveProperty('payload_ciphertext');
    expect((await rowOf(id))?.payload_ciphertext).not.toBeNull();
    expect(said(finished)).toEqual(
      expect.arrayContaining([
        'redemption record readers are not built yet: the worker claims no message, and every queued message waits unspent until they are',
      ]),
    );
    expect(said(finished)).not.toContain('delivery claimed');
    expect(finished.stdout).not.toContain('SENTINEL-PROCESS-TOKEN');
  });
});

/** The line the fixture's stalling provider writes as it receives a message (test/support/worker-process-fixture.mjs). */
const SEND_ANNOUNCEMENT = 'fixture: the provider received a message';

/**
 * What a stop with a message in flight must leave, however the stop signal was delivered: the process says it stopped and ends by
 * itself with exit code 0 and nothing on stderr, the job it was sending is RETRYABLE with its lease given back (RELINQUISHED, the one
 * attempt counted), the stop reports the one relinquished and none unconfirmed, and neither the token nor the destination was written.
 */
async function expectTheMessageGivenBack(finished: Finished, id: string): Promise<void> {
  expect(finished).toMatchObject({ code: 0, signal: null, stderr: '' });
  expect(said(finished)).toEqual(
    expect.arrayContaining([
      'delivery worker started',
      'signal received',
      'delivery worker stopping',
      'delivery worker stopped',
      'shutdown complete',
    ]),
  );
  expect(await rowOf(id)).toMatchObject({
    state: 'RETRYABLE',
    outcome_class: 'RELINQUISHED',
    attempt_count: 1,
  });
  expect(finished.stdout).not.toContain('SENTINEL-PROCESS-TOKEN');
  expect(finished.stdout).not.toContain('process.recipient@example.test');
  const stopped = finished.stdout
    .split('\n')
    .filter((line) => line.includes('delivery worker stopped'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)[0];
  expect(stopped).toMatchObject({ relinquished: 1, unconfirmed: 0 });
}

describe('a worker process stopped with a message in flight (S0.18; OB-24)', () => {
  // Break caught: a process that exits with the lease held (the message is stranded until the lease ends), that leaves its exit code
  // non-zero for a stop it handled, or that records the stalled send as something it was not. The stop signal arrives as the
  // provider receives the message, so the job is claimed, leased and in flight.
  it('gives back the lease of the job it was sending, says so, and ends by itself with exit code 0', async () => {
    const id = await issue();
    const running = start(WORKER_FIXTURE, workerEnvironment(), [
      'stalling',
      '--signal-itself-on-send',
    ]);

    const finished = await running.waitForExit(DEADLINES.stop, 'did not end by itself');

    await expectTheMessageGivenBack(finished, id);
  });

  // Break caught: the same, through a real signal from the operating system (Linux and macOS and CI; skipped, not passed, on Windows).
  // THIS IS THE WORKER'S REAL-SIGTERM EVIDENCE WITH A MESSAGE IN FLIGHT (plan OB-24).
  //
  // The signal is sent as soon as the fixture says the provider holds the message, while the send has nearly all of its time (5 s, the
  // capture adapter's) and the stop's drain is shorter than what is left of it, so the stop gives the message back. The shutdown budget is
  // 3 s here (5 s above): the drain is then 1.5 s, and the signal may be late by up to 3.5 s on a slow runner before the send's time is
  // spent. A stop that came after the send's own time had run out would find it recorded as UNKNOWN (the message may have been taken),
  // which is right and is not what this tests. The first version waited for the worker's log line for the claim, which is written at
  // debug and so never at the default level, behind a catch that swallowed the timeout: it signalled eight seconds late, and the first
  // run on Linux (CI, 11 October 2026) found UNKNOWN.
  it.skipIf(process.platform === 'win32')('does the same after a real SIGTERM', async () => {
    const id = await issue();
    const running = start(WORKER_FIXTURE, { ...workerEnvironment(), SHUTDOWN_TIMEOUT_MS: '3000' }, [
      'stalling',
    ]);
    await until(
      () => running.stdout.includes(SEND_ANNOUNCEMENT),
      'the provider to receive the message',
    );

    running.signal('SIGTERM');
    const finished = await running.waitForExit(DEADLINES.stop, 'did not end after SIGTERM');

    await expectTheMessageGivenBack(finished, id);
  });
});
