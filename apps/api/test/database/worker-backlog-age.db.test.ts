import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { WorkerJobStore } from '../../src/platform/delivery/worker/worker-job-store.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { closeAll } from '../support/teardown.js';
import { openAdmin, type Admin } from './support/admin.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The delivery backlog gauge (S0.68; OBSERVABILITY_AND_RECOVERY.md section 3, "Queue"): `credential_delivery_oldest_due_age_seconds` is
 * how long ago the oldest message that is due was queued, on the database's clock, and zero when none is due. The alert on a message
 * that waits reads it, so each way a message is not due, or is due, is held here on its own, as the worker's `claim` reads them: the
 * rehearsal (`alert-rehearsal.db.test.ts`) reads the gauge through the process's own wiring, once.
 */

let database: TestDatabase;
let work: BuiltService;
let admin: Admin;
let store: WorkerJobStore;

beforeAll(async () => {
  database = await createTestDatabase();
  work = buildService(database, { poolMax: 2, login: WORKER_RUNTIME_ROLE });
  admin = await openAdmin(database);
  store = new WorkerJobStore({
    database: work.service,
    cipher: new AesGcmSecretCipher(localKeys()),
    clock: new SystemClock(),
  });
});

afterAll(async () => {
  await closeAll([
    () => (admin as Admin | undefined)?.close(),
    () => (work as BuiltService | undefined)?.close(),
    () => (database as TestDatabase | undefined)?.drop(),
  ]);
});

beforeEach(async () => {
  await admin.query('delete from credential_delivery_job');
});

type State = 'QUEUED' | 'RETRYABLE' | 'LEASED' | 'ACCEPTED';

interface Job {
  readonly state: State;
  /** When it was queued, in seconds before now. */
  readonly queued: number;
  /** When its next attempt is due, in seconds from now (negative: it has come). */
  readonly next?: number;
  /** When its lease ends, in seconds from now, for a leased one. */
  readonly lease?: number;
  /** When its credential ends, in seconds from now. */
  readonly ends?: number;
}

const from = (seconds: number): string => `now() + interval '${String(seconds)} seconds'`;

/** A row in the state the table's constraints admit for it (migration 0009), arranged as the administrator, past row-level security. */
async function arrange(job: Job): Promise<void> {
  const live = job.state !== 'ACCEPTED';
  const leased = job.state === 'LEASED';
  await admin.query(
    `insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id, channel,
                                          state, attempt_count, next_attempt_at, expires_at, accepted_at, lease_owner, lease_version,
                                          lease_expires_at, provider_dedupe_id, outcome_class, payload_ciphertext, payload_nonce,
                                          payload_key_version, payload_envelope_version, payload_erased_at, created_at)
     values ($1, 'SETUP_GRANT', 'SETUP_GRANT', $2, 'STAFF', $3, 'EMAIL', '${job.state}', ${job.state === 'QUEUED' ? '0' : '1'},
             ${from(job.next ?? -1)}, ${from(job.ends ?? 3600)}, ${job.state === 'ACCEPTED' ? 'now()' : 'null'},
             ${leased ? "'worker-1'" : 'null'}, ${leased ? '1' : '0'}, ${leased ? from(job.lease ?? 60) : 'null'}, $4,
             ${job.state === 'RETRYABLE' ? "'UNKNOWN'" : job.state === 'ACCEPTED' ? "'ACCEPTED'" : 'null'},
             ${live ? "decode(repeat('ab', 40), 'hex')" : 'null'}, ${live ? "decode(repeat('cd', 12), 'hex')" : 'null'},
             ${live ? '1' : 'null'}, ${live ? '1' : 'null'}, ${live ? 'null' : 'now()'}, now() - interval '${String(job.queued)} seconds')`,
    [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  );
}

/** The gauge, and the bounds it must lie in: the seconds a row has waited, and the few the arrangement and the read took. */
async function age(): Promise<number> {
  return store.oldestDueAgeSeconds();
}
const about = (seconds: number): { min: number; max: number } => ({
  min: seconds - 1,
  max: seconds + 30,
});

describe('the delivery backlog gauge reads what the worker would claim', () => {
  // Break caught: a gauge that reads a number when there is nothing to wait for, which would page for an empty queue.
  it('is zero when no message is queued', async () => {
    expect(await age()).toBe(0);
  });

  // Break caught: the age of the oldest message read as the newest's, or as a sum, or counted from when it was last tried.
  it('is the time since the oldest due message was queued', async () => {
    await arrange({ state: 'QUEUED', queued: 50 });
    await arrange({ state: 'QUEUED', queued: 90 });
    await arrange({ state: 'QUEUED', queued: 70 });
    const seen = await age();
    expect(seen).toBeGreaterThanOrEqual(about(90).min);
    expect(seen).toBeLessThan(about(90).max);
  });

  // Break caught: a retry's age counted from its last attempt, which would hide how long the person has waited for the link.
  it('counts a message that is being retried from when it was first queued', async () => {
    await arrange({ state: 'RETRYABLE', queued: 300, next: -10 });
    const seen = await age();
    expect(seen).toBeGreaterThanOrEqual(about(300).min);
    expect(seen).toBeLessThan(about(300).max);
  });

  // Break caught: a message that is waiting on purpose (its next attempt is in the future) counted as a backlog.
  it('does not count a message whose next attempt has not come', async () => {
    await arrange({ state: 'RETRYABLE', queued: 1000, next: 300 });
    expect(await age()).toBe(0);
  });

  // Break caught: a message another worker holds a live lease on counted as waiting, or one whose lease ended with no outcome (a worker
  // that died) not counted: it is what the worker would take next.
  it('does not count a live lease, and counts one that ended with no outcome', async () => {
    await arrange({ state: 'LEASED', queued: 500, lease: 60 });
    expect(await age()).toBe(0);
    await arrange({ state: 'LEASED', queued: 200, lease: -5 });
    const seen = await age();
    expect(seen).toBeGreaterThanOrEqual(about(200).min);
    expect(seen).toBeLessThan(about(200).max);
  });

  // Break caught: a message whose credential has ended counted: nobody will be sent it, and the page would never clear.
  it('does not count a message whose credential has ended', async () => {
    await arrange({ state: 'QUEUED', queued: 1000, ends: -10 });
    expect(await age()).toBe(0);
  });

  // Break caught: a message that was sent counted as one that waits.
  it('does not count a message that was accepted', async () => {
    await arrange({ state: 'ACCEPTED', queued: 1000 });
    expect(await age()).toBe(0);
  });
});
