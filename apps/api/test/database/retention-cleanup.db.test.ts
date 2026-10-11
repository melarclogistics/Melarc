import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import {
  RetentionCleanup,
  eraseDueReplaysStatement,
} from '../../src/platform/delivery/retention/retention-cleanup.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import { PRINCIPAL_1, systemContext } from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.19 against a real PostgreSQL: the retention cleanup of the delivery worker. It erases credential material whose time has
 * passed, under the `credential_delivery` capability as `melarc_worker_runtime`: the payload of a message whose redemption record has
 * ended, and the sealed replay of an idempotency record whose window has closed. **It deletes nothing**: no identity holds `DELETE`
 * on either table (data-scope registry §5.2), and the retention of a finished job's metadata is unset (OQ-028).
 */

const clock = new SystemClock();
const ISSUER: SecurityContext = systemContext('authentication');
const WORKER: SecurityContext = systemContext('credential_delivery');
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
  // Break caught: a message for a credential that has ended being kept for ever (its payload, which holds a live token, stays), or the
  // end marked on a job whose record is still pending.
  it('expires a job whose record has ended, erasing the payload, and leaves one whose record has not', async () => {
    const ended = await issue(-5);
    const waiting = await issue(30);

    const report = await cleanup().runOnce();

    expect(report).toMatchObject({ jobsExpired: 1, more: false });
    expect(await rowOf(ended.id)).toMatchObject({
      state: 'EXPIRED',
      outcome_class: 'EXPIRED',
      payload_ciphertext: null,
    });
    expect((await rowOf(ended.id)).payload_erased_at).toBeInstanceOf(Date);
    expect(await rowOf(waiting.id)).toMatchObject({ state: 'QUEUED' });
    expect((await rowOf(waiting.id)).payload_ciphertext).not.toBeNull();
  });

  // Break caught: a job that waits on its schedule past the end of its record, or one whose worker died with the lease, being kept.
  it('expires a retryable job, and a leased job whose lease ended, that are past the end of their record', async () => {
    const retryable = await issue(30);
    const claimed = await queue.claim('dw-retention', 30_000);
    expect(claimed?.job.id).toBeDefined();
    if (claimed === null) throw new Error('expected a job');
    await queue.recordOutcome(claimed, { outcome: 'UNKNOWN' });
    await overdue(retryable.id);
    const died = await issue(30);
    await queue.claim('dw-died', 30_000);
    await overdue(died.id);
    await arrange(
      `update credential_delivery_job set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [died.id],
    );

    const report = await cleanup().runOnce();

    expect(report.jobsExpired).toBe(2);
    // One of the two had a lease that ended with no outcome: that is counted, because no takeover will ever come for it.
    expect(report.leasesExpired).toBe(1);
    expect(await rowOf(retryable.id)).toMatchObject({ state: 'EXPIRED', payload_ciphertext: null });
    expect(await rowOf(died.id)).toMatchObject({ state: 'EXPIRED', payload_ciphertext: null });
  });

  // Break caught: the cleanup taking a job from under a worker that is still sending it (the lease is held), which would make the
  // worker's outcome a lost lease for no reason.
  it('leaves a leased job whose lease is still held, though its record has ended', async () => {
    const inFlight = await issue(30);
    const claimed = await queue.claim('dw-sending', 30_000);
    if (claimed === null) throw new Error('expected a job');
    await overdue(inFlight.id);

    const report = await cleanup().runOnce();

    expect(report.jobsExpired).toBe(0);
    expect(await rowOf(inFlight.id)).toMatchObject({ state: 'LEASED', lease_owner: 'dw-sending' });
  });

  // Break caught: a job that has ended being touched again, or deleted: the row and its metadata stay (their retention is OQ-028).
  it('keeps the rows of jobs that ended, whatever their state, and deletes nothing', async () => {
    const accepted = await issue(30);
    const first = await queue.claim('dw-a', 30_000);
    if (first === null) throw new Error('expected a job');
    await queue.recordOutcome(first, { outcome: 'ACCEPTED', providerMessageRef: 'r' });
    const cancelled = await issue(30);
    await withHandle(api.service, ISSUER, (handle) =>
      queue.cancel(handle, {
        by: 'redemption',
        redemption: { type: 'SETUP_GRANT', id: cancelled.redemptionId },
      }),
    );
    const failed = await issue(30);
    const second = await queue.claim('dw-b', 30_000);
    if (second === null) throw new Error('expected a job');
    await queue.recordOutcome(second, { outcome: 'REJECTED', outcomeClass: 'REJECTED' });
    for (const each of [accepted, cancelled, failed]) await overdue(each.id);
    const before = await observer.rows('select * from credential_delivery_job order by id');

    const report = await cleanup().runOnce();

    expect(report.jobsExpired).toBe(0);
    expect(await observer.rows('select * from credential_delivery_job order by id')).toEqual(
      before,
    );
    expect(before).toHaveLength(3);
  });

  // Break caught: a cleanup that does everything in one unbounded statement (a table of a million rows locked at once), or that stops
  // after one batch and leaves the rest for a day. It is bounded, says there is more, and finishes in rounds.
  it('works in batches, says when there is more, and finishes', async () => {
    const jobs = [];
    for (let index = 0; index < 5; index += 1) jobs.push(await issue(-5));
    const batched = cleanup(2);

    const first = await batched.runOnce();
    const second = await batched.runOnce();
    const third = await batched.runOnce();
    const fourth = await batched.runOnce();

    expect([first, second, third, fourth]).toEqual([
      { jobsExpired: 2, replayErased: 0, leasesExpired: 0, more: true },
      { jobsExpired: 2, replayErased: 0, leasesExpired: 0, more: true },
      { jobsExpired: 1, replayErased: 0, leasesExpired: 0, more: false },
      { jobsExpired: 0, replayErased: 0, leasesExpired: 0, more: false },
    ]);
    for (const job of jobs) expect((await rowOf(job.id)).state).toBe('EXPIRED');
  });

  // Break caught: two cleanups at once expiring one job twice, or waiting on each other.
  it('lets two cleanups at once expire each job exactly once', async () => {
    for (let index = 0; index < 6; index += 1) await issue(-5);

    const reports = await Promise.all([cleanup(3).runOnce(), cleanup(3).runOnce()]);

    expect(reports.reduce((sum, report) => sum + report.jobsExpired, 0)).toBe(6);
    expect(await observer.count('credential_delivery_job', { state: 'EXPIRED' })).toBe(6);
  });

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

/** An idempotency record as the administrator arranges it: completed, with a sealed replay unless told otherwise. */
async function insertReplay(
  over: {
    readonly state?: 'COMPLETED' | 'IN_PROGRESS';
    readonly sealedExpiresInSeconds?: number | null;
    readonly tombstone?: boolean;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const state = over.state ?? 'COMPLETED';
  const sealed = over.sealedExpiresInSeconds === undefined ? -60 : over.sealedExpiresInSeconds;
  const holdsSealed = state === 'COMPLETED' && sealed !== null && over.tombstone !== true;
  await admin.query(
    `insert into idempotency_record
       (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state, completed_at,
        response_status, response_body, sealed_ciphertext, sealed_nonce, sealed_key_version, sealed_envelope_version,
        sealed_expires_at, replay_unavailable_at)
     values ($1, 'STAFF', $2, 'registerRiderDevice', $3, $4, $5,
        case when $5 = 'COMPLETED' then now() end,
        case when $5 = 'COMPLETED' then 201 end,
        case when $5 = 'COMPLETED' then decode('7b7d', 'hex') end,
        case when $6 then decode('aabbcc', 'hex') end, case when $6 then decode('000102030405060708090a0b', 'hex') end,
        case when $6 then 1 end, case when $6 then 1 end,
        case when $6 then now() + ($7::int * interval '1 second') end,
        case when $8 then now() end)`,
    [
      id,
      PRINCIPAL_1,
      `key-${id}`,
      'a'.repeat(64),
      state,
      holdsSealed,
      sealed ?? 0,
      over.tombstone === true,
    ],
  );
  return id;
}

interface ReplayRow {
  readonly state: string;
  readonly response_status: number | null;
  readonly response_body: Buffer | null;
  readonly sealed_ciphertext: Buffer | null;
  readonly sealed_nonce: Buffer | null;
  readonly sealed_key_version: number | null;
  readonly sealed_envelope_version: number | null;
  readonly sealed_expires_at: Date | null;
  readonly replay_unavailable_at: Date | null;
}
const replayOf = async (id: string): Promise<ReplayRow> => {
  const row = await observer.one<ReplayRow>('select * from idempotency_record where id = $1', [id]);
  if (row === undefined) throw new Error(`no record ${id}`);
  return row;
};

describe('the retention cleanup of sealed replays (S0.19)', () => {
  // Break caught: a sealed replay (a secret kept for a replay window) staying for ever, or the answer being lost with it: the record
  // keeps its answer byte for byte, loses only the sealed fields, and says they were there.
  it('erases the sealed replay of a record whose window has closed, sets the tombstone and keeps the answer', async () => {
    const expired = await insertReplay({ sealedExpiresInSeconds: -60 });
    const before = await replayOf(expired);

    const report = await cleanup().runOnce();

    expect(report).toMatchObject({ replayErased: 1, more: false });
    const after = await replayOf(expired);
    expect(after).toMatchObject({
      state: 'COMPLETED',
      response_status: 201,
      sealed_ciphertext: null,
      sealed_nonce: null,
      sealed_key_version: null,
      sealed_envelope_version: null,
      sealed_expires_at: null,
    });
    expect(after.response_body).toEqual(before.response_body);
    expect(after.replay_unavailable_at).toBeInstanceOf(Date);
  });

  // Break caught: a replay erased early (a client retrying inside its window finding nothing), or a record with none touched.
  it('leaves a record whose window is open, one with no sealed replay, one already erased, and one in progress', async () => {
    const open = await insertReplay({ sealedExpiresInSeconds: 3_600 });
    const none = await insertReplay({ sealedExpiresInSeconds: null });
    const erased = await insertReplay({ tombstone: true });
    const inProgress = await insertReplay({ state: 'IN_PROGRESS' });
    const before = await Promise.all([open, none, erased, inProgress].map(replayOf));

    const report = await cleanup().runOnce();

    expect(report.replayErased).toBe(0);
    expect(await Promise.all([open, none, erased, inProgress].map(replayOf))).toEqual(before);
    expect(before[0]?.sealed_ciphertext).not.toBeNull();
  });

  // Break caught: the cleanup deleting a record (the registry gives no identity DELETE), losing the key of a replay, or leaving a
  // partial erase.
  it('deletes nothing, and a second run finds nothing more', async () => {
    const ids = [
      await insertReplay(),
      await insertReplay(),
      await insertReplay({ sealedExpiresInSeconds: 600 }),
    ];

    const first = await cleanup().runOnce();
    const second = await cleanup().runOnce();

    expect(first.replayErased).toBe(2);
    expect(second).toEqual({ jobsExpired: 0, replayErased: 0, leasesExpired: 0, more: false });
    expect(await observer.count('idempotency_record')).toBe(3);
    expect(ids).toHaveLength(3);
  });

  // Break caught: unbounded work, as for the jobs.
  it('works in batches and says when there is more', async () => {
    for (let index = 0; index < 5; index += 1) await insertReplay();
    const batched = cleanup(2);

    const reports = [await batched.runOnce(), await batched.runOnce(), await batched.runOnce()];

    expect(reports.map((report) => [report.replayErased, report.more])).toEqual([
      [2, true],
      [2, true],
      [1, false],
    ]);
  });

  // Break caught: both kinds of material done by the one run, so that a stuck kind starves the other is the thing to avoid: a run
  // reports both.
  it('does both kinds of work in one run', async () => {
    await issue(-5);
    await insertReplay();

    expect(await cleanup().runOnce()).toEqual({
      jobsExpired: 1,
      replayErased: 1,
      leasesExpired: 0,
      more: false,
    });
  });
});

describe('what the cleanup’s capability can and cannot do to the replay table (S0.19)', () => {
  const asWorker = async (statement: ReturnType<typeof sql>) => {
    try {
      await withHandle(work.service, WORKER, (_handle, tx) => tx.execute(statement));
      return undefined;
    } catch (error) {
      return serverErrorIn(error)?.code ?? 'other';
    }
  };

  // Break caught: the worker reading what it only erases (the sealed bytes, the answer), or changing any column but the sealed ones.
  it('is refused the sealed bytes, the saved answer and every column but the ones it erases', async () => {
    const id = await insertReplay({ sealedExpiresInSeconds: 3_600 });

    expect(
      await asWorker(sql`select sealed_ciphertext from idempotency_record where id = ${id}`),
    ).toBe('42501');
    expect(await asWorker(sql`select response_body from idempotency_record where id = ${id}`)).toBe(
      '42501',
    );
    expect(
      await asWorker(sql`update idempotency_record set response_status = 200 where id = ${id}`),
    ).toBe('42501');
    expect(
      await asWorker(
        sql`update idempotency_record set fingerprint = ${'b'.repeat(64)} where id = ${id}`,
      ),
    ).toBe('42501');
    expect(await asWorker(sql`select principal_id from idempotency_record where id = ${id}`)).toBe(
      '42501',
    );
    expect((await replayOf(id)).sealed_ciphertext).not.toBeNull();
  });

  // Break caught: a record that has already been erased being reached again (its tombstone is set once, with the erasure): to the
  // cleanup's capability it is not there to change.
  it('finds nothing to change in a record that has already been erased', async () => {
    const id = await insertReplay({ tombstone: true });

    const rows = await withHandle(
      work.service,
      WORKER,
      async (_handle, tx) =>
        (
          await tx.execute(
            sql`update idempotency_record set replay_unavailable_at = clock_timestamp() where id = ${id}`,
          )
        ).rowCount,
    );

    expect(rows).toBe(0);
  });

  // Break caught: the erase policies admitting any system context, so that the limiter's capability, over the API's connection (which
  // holds the table privileges), could reach a record to change: to every capability but the cleanup's there is none to change.
  it('shows another system capability no record to erase', async () => {
    await insertReplay({ sealedExpiresInSeconds: -60 });

    const rows = await withHandle(
      api.service,
      systemContext('rate_limit'),
      async (_handle, tx) =>
        (await tx.execute(sql`update idempotency_record set sealed_expires_at = null`)).rowCount,
    );

    expect(rows).toBe(0);
    expect((await observer.count('idempotency_record', {})) === 1).toBe(true);
  });

  // Break caught: the erase policy admitting a replay whose window is still open (a client retrying inside it would find nothing, and
  // the secret it was promised would be gone): the statement of the cleanup is not the only thing that keeps to the window, the
  // policy does too, so a capability that writes its own statement cannot erase a live replay, written whole and tombstoned as it is.
  it('finds no record to erase while its window is open, though the erase is written whole and tombstoned', async () => {
    const id = await insertReplay({ sealedExpiresInSeconds: 3_600 });

    const rows = await withHandle(
      work.service,
      WORKER,
      async (_handle, tx) =>
        (
          await tx.execute(
            sql`update idempotency_record set sealed_ciphertext = null, sealed_nonce = null, sealed_key_version = null,
                  sealed_envelope_version = null, sealed_expires_at = null, replay_unavailable_at = clock_timestamp()
                where id = ${id}`,
          )
        ).rowCount,
    );

    expect(rows).toBe(0);
    expect((await replayOf(id)).sealed_ciphertext).not.toBeNull();
  });

  // Break caught: the worker inserting or deleting records, or truncating the table.
  it('cannot insert, delete or truncate', async () => {
    const id = await insertReplay();

    expect(await asWorker(sql`delete from idempotency_record where id = ${id}`)).toBe('42501');
    expect(await asWorker(sql`truncate idempotency_record`)).toBe('42501');
    expect(
      await asWorker(
        sql`insert into idempotency_record (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state)
            values (${randomUUID()}, 'STAFF', ${PRINCIPAL_1}, 'op', 'k', ${'c'.repeat(64)}, 'IN_PROGRESS')`,
      ),
    ).toBe('42501');
  });

  // Break caught: the erasure written by hand without its tombstone, or in part: only the whole, tombstoned erase is allowed.
  it('is allowed to erase a sealed replay only whole and with the tombstone', async () => {
    const id = await insertReplay({ sealedExpiresInSeconds: -60 });

    expect(
      await asWorker(
        sql`update idempotency_record set sealed_ciphertext = null, sealed_nonce = null, sealed_key_version = null,
              sealed_envelope_version = null, sealed_expires_at = null where id = ${id}`,
      ),
    ).toBeDefined();
    expect(
      await asWorker(sql`update idempotency_record set sealed_ciphertext = null where id = ${id}`),
    ).toBeDefined();
    expect((await replayOf(id)).sealed_ciphertext).not.toBeNull();
    expect(
      await asWorker(
        sql`update idempotency_record set sealed_ciphertext = null, sealed_nonce = null, sealed_key_version = null,
              sealed_envelope_version = null, sealed_expires_at = null, replay_unavailable_at = clock_timestamp()
            where id = ${id}`,
      ),
    ).toBeUndefined();
    expect((await replayOf(id)).sealed_ciphertext).toBeNull();
  });
});

describe('the cleanup of sealed replays reaches its rows through an index (G2-07)', () => {
  interface PlanNode {
    readonly [key: string]: unknown;
    readonly Plans?: readonly PlanNode[];
  }
  const flatten = (node: PlanNode | undefined): PlanNode[] =>
    node === undefined ? [] : [node, ...(node.Plans ?? []).flatMap(flatten)];

  const indexesOf = (nodes: readonly PlanNode[]): string[] =>
    nodes
      .map((node) => node['Index Name'])
      .filter((name): name is string => typeof name === 'string');

  /** The plan and the work of the cleanup's own statement, as the worker's role under its capability and its row-level policies. */
  async function planOfCleanup(): Promise<{
    readonly nodes: PlanNode[];
    readonly blocks: number;
    readonly text: string;
  }> {
    class Planned extends Error {
      constructor(readonly plan: readonly { Plan: PlanNode }[]) {
        super('planned');
      }
    }
    const statement = eraseDueReplaysStatement(100);
    const planned = await work.service
      .transactionWithContext(WORKER, async (tx) => {
        const result = await tx.execute(sql`explain (analyze, buffers, format json) ${statement}`);
        // The statement was run to be measured: it is rolled back, so that the measurement changes nothing.
        const row = result.rows[0];
        throw new Planned(row?.['QUERY PLAN'] as never);
      })
      .catch((error: unknown) => {
        if (error instanceof Planned) return error.plan;
        throw error;
      });
    const root = planned[0]?.Plan;
    return {
      nodes: flatten(root),
      // The root node counts the pages of the whole statement (a node's count includes its children's): not the sum of the nodes'.
      blocks: Number(root?.['Shared Hit Blocks'] ?? 0) + Number(root?.['Shared Read Blocks'] ?? 0),
      text: JSON.stringify(planned),
    };
  }

  // Break caught (the defect): the cleanup filtering and ordering on the end of the window with nothing to find it by, so that every
  // run reads every record that holds a sealed replay, and a run that finds nothing due reads them all to say so. The table is taken
  // at a size where that shows (sixty thousand records, fifty of them due, twenty thousand already erased), as the worker's role
  // with its row-level policies, and the planner is left to choose: no setting is forced.
  it('finds the records that are due through the expiry index, reading a few pages and not the table', async () => {
    await admin.query(
      `insert into idempotency_record
         (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state, completed_at, response_status,
          response_body, sealed_ciphertext, sealed_nonce, sealed_key_version, sealed_envelope_version, sealed_expires_at)
       select gen_random_uuid(), 'STAFF', ${sqlLiteral(PRINCIPAL_1)}::uuid, 'registerRiderDevice', 'key-' || g, repeat('a', 64),
              'COMPLETED', now(), 201, decode('7b7d', 'hex'), decode(repeat('ab', 60), 'hex'), decode('000102030405060708090a0b', 'hex'),
              1, 1,
              case when g <= 50 then now() - make_interval(secs => g) else now() + make_interval(hours => 1, secs => g) end
         from generate_series(1, 60000) as g`,
    );
    await admin.query(
      `insert into idempotency_record
         (id, principal_type, principal_id, operation_id, idempotency_key, fingerprint, state, completed_at, response_status,
          response_body, replay_unavailable_at)
       select gen_random_uuid(), 'STAFF', ${sqlLiteral(PRINCIPAL_1)}::uuid, 'registerRiderDevice', 'erased-' || g, repeat('b', 64),
              'COMPLETED', now(), 201, decode('7b7d', 'hex'), now() - interval '1 day'
         from generate_series(1, 20000) as g`,
    );
    await admin.query('analyze idempotency_record');
    const pages = await observer.one<{ pages: number }>(
      `select relpages::int as pages from pg_class where relname = 'idempotency_record'`,
    );
    expect(pages?.pages ?? 0).toBeGreaterThan(1000);

    const { nodes, blocks } = await planOfCleanup();

    // the index holds only the records that still hold a sealed replay, and its condition is fixed: no clock, no function
    const definition = await observer.one<{ predicate: string | null }>(
      `select pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'idempotency_record_sealed_expiry_idx'`,
    );
    expect(definition?.predicate).toBe('(sealed_expires_at IS NOT NULL)');
    expect(indexesOf(nodes)).toContain('idempotency_record_sealed_expiry_idx');
    expect(
      nodes.filter(
        (node) =>
          node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'idempotency_record',
      ),
    ).toEqual([]);
    // the batch of fifty due records and the pages around them, against a table of thousands of pages
    expect(blocks).toBeLessThan(1500);
    // and nothing due: a run that finds nothing reads a descent of the index and no more. The fifty due records are erased, as the
    // cleanup would erase them (the guard allows nothing else), and the statement is planned again.
    await admin.query(
      `update idempotency_record
          set sealed_ciphertext = null, sealed_nonce = null, sealed_key_version = null, sealed_envelope_version = null,
              sealed_expires_at = null, replay_unavailable_at = now()
        where sealed_expires_at <= now()`,
    );
    const idle = await planOfCleanup();
    expect(indexesOf(idle.nodes)).toContain('idempotency_record_sealed_expiry_idx');
    expect(idle.blocks).toBeLessThan(60);
  }, 120_000);
});

/** A text that is already safe to put in a statement (a UUID of the fixture), for a bulk insert that is not parameterised. */
function sqlLiteral(uuid: string): string {
  if (!/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('not a uuid');
  return `'${uuid}'`;
}
