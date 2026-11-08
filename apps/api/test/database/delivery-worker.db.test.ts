import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import type {
  DeliveryProvider,
  ProviderMessage,
} from '../../src/platform/auth/ports/delivery-provider.port.js';
import type {
  DeliveryJobRef,
  DeliveryOutcome,
  DeliveryRequest,
} from '../../src/platform/auth/ports/delivery-queue.port.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { MemoryCaptureSink } from '../../src/platform/delivery/worker/capture-sink.js';
import {
  DeliveryWorker,
  type DeliveryWorkerOptions,
} from '../../src/platform/delivery/worker/delivery-worker.js';
import {
  UNBUILT_REDEMPTION_READER,
  type RedemptionRecordReader,
  type RedemptionStanding,
} from '../../src/platform/delivery/worker/redemption-record-reader.js';
import { createServiceLogger } from '../../src/platform/logging/create-logger.js';
import { BoundedMetrics } from '../../src/platform/metrics/bounded.metrics.adapter.js';
import {
  BudgetExpiredError,
  ExecutionBudget,
  runWithBudget,
} from '../../src/platform/execution/execution-budget.js';
import { UnreadableClaimError } from '../../src/platform/delivery/delivery-errors.js';
import { RetentionCleanup } from '../../src/platform/delivery/retention/retention-cleanup.js';
import type { PurposeKeys } from '../../src/platform/config/key-material.js';
import { localKeys, purposeKeys } from '../../src/test-support/key-config.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import { PRINCIPAL_1, systemContext } from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.18 against a real PostgreSQL: the delivery worker over the real queue, as `melarc_worker_runtime` for the worker side and
 * `melarc_api_runtime` for the issuing side, with a provider that behaves as the plan's evidence list needs it to (it keeps the
 * message, loses the acknowledgement, answers late or never). The redemption record is a stand-in table, because the real
 * `setup_grant` and `recovery_request` arrive in S0.29 and S0.50. Effects are read from a second connection.
 */

const clock = new SystemClock();
const SENTINEL_TOKEN = 'SENTINEL-WORKER-TOKEN-91c2d5e7a0b34f68';
const SENTINEL_DESTINATION = 'sentinel.worker.recipient@example.test';
const ISSUER: SecurityContext = systemContext('authentication');
const WORKER_APPLICATION = 'melarc-delivery-worker';

let database: TestDatabase;
let api: BuiltService;
let work: BuiltService;
let admin: Admin;
let observer: Observer;
const cipher = new AesGcmSecretCipher(localKeys());
let queue: PostgresDeliveryQueue;

beforeAll(async () => {
  database = await createTestDatabase();
  api = buildService(database, { poolMax: 4 });
  work = buildService(database, {
    poolMax: 8,
    login: WORKER_RUNTIME_ROLE,
    applicationName: WORKER_APPLICATION,
  });
  admin = await openAdmin(database);
  observer = await observe(database);
  await admin.query(`create table public.delivery_fixture_redemption (
      id uuid primary key, state text not null, expires_at timestamptz not null)`);
  await admin.query('alter table public.delivery_fixture_redemption owner to melarc_owner');
  await admin.query(
    `grant select, insert, update on public.delivery_fixture_redemption to ${API_RUNTIME_ROLE}`,
  );
  queue = new PostgresDeliveryQueue({ cipher, clock, work: work.service, random: () => 0.5 });
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await api.close();
  await work.close();
  await database.drop();
});

beforeEach(async () => {
  await admin.query('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
});

const workers: DeliveryWorker[] = [];
afterEach(async () => {
  for (const each of workers.splice(0)) await each.stop(500).catch(() => undefined);
});

const inMinutes = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('the condition did not come true in time');
    await sleep(10);
  }
}

/** A hold a test releases: whoever awaits `promise` waits until `release()` is called. */
interface Latch {
  readonly promise: Promise<undefined>;
  release(): void;
}
function latch(): Latch {
  let release: () => void = () => undefined;
  const promise = new Promise<undefined>((resolve) => {
    release = () => {
      resolve(undefined);
    };
  });
  return { promise, release };
}

/** What an issuing operation does: write the redemption record and queue its message in one transaction of the API. */
async function issue(
  over: Partial<DeliveryRequest> = {},
  using: PostgresDeliveryQueue = queue,
): Promise<{
  readonly redemptionId: string;
  readonly job: DeliveryJobRef;
  readonly request: DeliveryRequest;
}> {
  const request: DeliveryRequest = {
    kind: 'SETUP_GRANT',
    redemption: { type: 'SETUP_GRANT', id: randomUUID() },
    principal: { type: 'STAFF', id: PRINCIPAL_1 },
    channel: 'EMAIL',
    destination: SENTINEL_DESTINATION,
    link: `https://ops.example.test/setup/credential#token=${SENTINEL_TOKEN}`,
    expiresAt: inMinutes(30),
    ...over,
  };
  const job = await withHandle(api.service, ISSUER, async (handle, tx) => {
    await tx.execute(
      sql`insert into delivery_fixture_redemption (id, state, expires_at)
          values (${request.redemption.id}, 'PENDING', ${request.expiresAt.toISOString()}::timestamptz)`,
    );
    return using.enqueue(handle, request);
  });
  return { redemptionId: request.redemption.id, job, request };
}

interface Row {
  readonly state: string;
  readonly attempt_count: number;
  readonly lease_owner: string | null;
  readonly lease_version: number;
  readonly provider_message_ref: string | null;
  readonly outcome_class: string | null;
  readonly payload_ciphertext: Buffer | null;
  readonly next_attempt_at: Date;
  readonly deferred_claims: number;
}

const rowOf = async (id: string): Promise<Row> => {
  const row = await observer.one<Row>('select * from credential_delivery_job where id = $1', [id]);
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
};

const redemptionState = async (id: string): Promise<string | undefined> =>
  (
    await observer.one<{ state: string }>(
      'select state from delivery_fixture_redemption where id = $1',
      [id],
    )
  )?.state;

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

const endLease = (id: string) =>
  arrange(
    `update credential_delivery_job set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [id],
  );
const makeDue = (id: string) =>
  arrange(
    `update credential_delivery_job set next_attempt_at = clock_timestamp() - interval '1 second' where id = $1`,
    [id],
  );
const clearJobs = async (): Promise<void> => {
  await arrange('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
};

/** The redemption record as the worker reads it: pending until it is consumed or ends, judged on the database's clock. */
class FixtureReader implements RedemptionRecordReader {
  async standing(record: { readonly id: string }): Promise<RedemptionStanding> {
    const row = await observer.one<{ standing: RedemptionStanding }>(
      `select case when state = 'PENDING' and expires_at > clock_timestamp() then 'PENDING' else 'CLOSED' end as standing
         from delivery_fixture_redemption where id = $1`,
      [record.id],
    );
    return row?.standing ?? 'CLOSED';
  }
}

/** A provider that keeps what it is given, and can be told to answer late, lose its acknowledgement, or wait to be released. */
class StoringProvider implements DeliveryProvider {
  readonly sink = new MemoryCaptureSink();
  readonly sends: ProviderMessage[] = [];
  /** The identities it was asked about (a retry asks before it sends). */
  readonly statusAsked: string[] = [];
  hasStatus = true;
  delayBeforeStoreMs = 0;
  /** What it answers once the message is stored. */
  answer: (message: ProviderMessage) => Promise<DeliveryOutcome> = (message) =>
    Promise.resolve({
      outcome: 'ACCEPTED',
      providerMessageRef: `ref-${message.dedupeId.slice(0, 8)}`,
    });
  /** Runs when a send arrives, before anything else (a hold for a test to release). */
  onArrival: (message: ProviderMessage) => Promise<unknown> = () => Promise.resolve();

  async send(message: ProviderMessage): Promise<DeliveryOutcome> {
    this.sends.push(message);
    await this.onArrival(message);
    if (this.delayBeforeStoreMs > 0) await sleep(this.delayBeforeStoreMs);
    this.sink.messages.set(message.dedupeId, {
      capturedAt: new Date().toISOString(),
      dedupeId: message.dedupeId,
      kind: message.kind,
      channel: message.channel,
      destination: message.destination,
      link: message.link,
    });
    return this.answer(message);
  }

  status(dedupeId: string): Promise<DeliveryOutcome | null> {
    this.statusAsked.push(dedupeId);
    if (!this.hasStatus || !this.sink.messages.has(dedupeId)) return Promise.resolve(null);
    return Promise.resolve({
      outcome: 'ACCEPTED',
      providerMessageRef: `held-${dedupeId.slice(0, 8)}`,
    });
  }
}

interface Rig {
  readonly worker: DeliveryWorker;
  readonly provider: StoringProvider;
  readonly metrics: BoundedMetrics;
  readonly lines: () => Record<string, unknown>[];
  readonly text: () => string;
}

function newWorker(
  name: string,
  provider = new StoringProvider(),
  over: Partial<DeliveryWorkerOptions> = {},
  reader: RedemptionRecordReader = new FixtureReader(),
): Rig {
  const raw: string[] = [];
  const metrics = new BoundedMetrics({ policy: 'throw', clock });
  const worker = new DeliveryWorker({
    queue,
    providers: { EMAIL: provider, SMS: provider },
    providerTimeoutMs: { EMAIL: 2_000, SMS: 2_000 },
    redemption: reader,
    clock,
    logger: createServiceLogger({
      service: 'melarc-delivery-worker',
      level: 'debug',
      appEnv: 'local',
      destination: { write: (line: string) => void raw.push(line) },
    }),
    metrics,
    workerId: name,
    concurrency: 1,
    pollIntervalMs: 100,
    leaseMs: 30_000,
    jobBudgetMs: 25_000,
    ...over,
  });
  workers.push(worker);
  return {
    worker,
    provider,
    metrics,
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => raw.join(''),
  };
}

const counter = (metrics: BoundedMetrics, name: string, labels: Record<string, string> = {}) =>
  metrics
    .snapshot()
    .counters.find(
      (entry) =>
        entry.name === name &&
        Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
    )?.value ?? 0;

describe('a message from the queue to the provider and back (S0.18)', () => {
  // Break caught: a message sent twice, or never, or an outcome not written; a payload left in a job that has been accepted.
  it('sends a queued message once, records it accepted and erases the payload', async () => {
    const issued = await issue();
    const a = newWorker('dw-a');

    expect(await a.worker.runOnce()).toBe(true);

    expect(a.provider.sends).toEqual([
      {
        dedupeId: issued.job.providerDedupeId,
        kind: 'SETUP_GRANT',
        channel: 'EMAIL',
        destination: SENTINEL_DESTINATION,
        link: issued.request.link,
      },
    ]);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      attempt_count: 1,
      outcome_class: 'ACCEPTED',
      payload_ciphertext: null,
    });
    expect((await rowOf(issued.job.id)).provider_message_ref).toMatch(/^ref-/);
    expect(await a.worker.runOnce()).toBe(false);
    await clearJobs();
  });

  // Break caught: the worker writing the destination, the link or the token anywhere it logs, on the path that works and on the ones
  // that do not, or in the logs of the database layer under it.
  it('writes no destination, link or token to its log or the database layer’s, on any path', async () => {
    const paths: [string, (provider: StoringProvider) => void][] = [
      ['accepted', () => undefined],
      [
        'a provider that throws what it was given',
        (provider) => {
          provider.answer = (message) =>
            Promise.reject(new Error(`failed for ${message.destination} with ${message.link}`));
        },
      ],
      [
        'a provider that rejects',
        (provider) => {
          provider.answer = () =>
            Promise.resolve({ outcome: 'REJECTED', outcomeClass: 'REJECTED' });
        },
      ],
    ];
    const logs: string[] = [];
    for (const [, shape] of paths) {
      await issue();
      const rig = newWorker('dw-log');
      shape(rig.provider);

      await rig.worker.runOnce();

      logs.push(rig.text());
      await clearJobs();
    }

    for (const text of [
      ...logs,
      JSON.stringify(work.logs.records()),
      JSON.stringify(api.logs.records()),
    ]) {
      for (const secret of [SENTINEL_TOKEN, SENTINEL_DESTINATION, '/setup/credential']) {
        expect(text).not.toContain(secret);
      }
    }
    expect(logs.join('')).toContain('delivery outcome recorded');
  });

  // Break caught: a worker that holds a connection while it waits for the provider (OB-56: no provider call holds a transaction open),
  // seen from outside: while the call is blocked, the worker's sessions are idle, none in a transaction, none running a statement.
  it('holds no transaction and runs no statement while the provider is being called', async () => {
    await issue();
    const hold = latch();
    const provider = new StoringProvider();
    provider.onArrival = () => hold.promise;
    const a = newWorker('dw-hold', provider);

    const working = a.worker.runOnce();
    await until(() => provider.sends.length === 1);
    const sessions = await observer.rows<{ state: string | null; application_name: string }>(
      `select state, application_name from pg_stat_activity where datname = $1 and usename = $2`,
      [database.name, WORKER_RUNTIME_ROLE],
    );
    hold.release();
    await working;

    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.application_name).toBe(WORKER_APPLICATION);
      expect(session.state).toBe('idle');
    }
    await clearJobs();
  });
});

describe('a worker that dies, a lease that ends, and two workers that ask at once (S0.18)', () => {
  // Break caught (crash after commit, before the send): a job whose worker died with the lease held being lost, or taken over without
  // counting the attempt, or sent twice.
  it('sends a job whose first worker died holding the lease, once the lease has ended', async () => {
    const issued = await issue();
    const died = await queue.claim('dw-died', 30_000);
    expect(died?.job.id).toBe(issued.job.id);
    expect(await newWorker('dw-early').worker.runOnce()).toBe(false);
    await endLease(issued.job.id);
    const b = newWorker('dw-b');

    expect(await b.worker.runOnce()).toBe(true);

    expect(b.provider.sends).toHaveLength(1);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      attempt_count: 2,
      lease_version: 2,
      lease_owner: 'dw-b',
    });
    expect(counter(b.metrics, 'credential_delivery_leases_expired_total')).toBe(1);
    await clearJobs();
  });

  // Break caught (crash after the send, before the outcome): the message sent a second time because the worker that took the job over
  // did not ask the provider first; the provider holds it, says so, and nothing more is sent.
  it('records a message the first worker had already sent, without sending it again', async () => {
    const issued = await issue();
    const died = await queue.claim('dw-died', 30_000);
    if (died === null) throw new Error('expected the job');
    const b = newWorker('dw-b');
    // The first worker's send reached the provider; then the process died.
    await b.provider.send({
      dedupeId: died.job.providerDedupeId,
      kind: died.kind,
      channel: died.channel,
      destination: died.request.destination,
      link: died.request.link,
    });
    await endLease(issued.job.id);

    expect(await b.worker.runOnce()).toBe(true);

    expect(b.provider.sends).toHaveLength(1);
    const row = await rowOf(issued.job.id);
    expect(row).toMatchObject({ state: 'ACCEPTED', attempt_count: 2, lease_owner: 'dw-b' });
    expect(row.provider_message_ref).toMatch(/^held-/);
    await clearJobs();
  });

  // Break caught: a seventh send, once for each lease that ends after a crash, until the credential expires (the schedule is six
  // attempts and then a terminal failure), or a job left to be claimed for ever.
  it('sends nothing for a job whose lease ended after its sixth attempt, and ends it as the end of the schedule', async () => {
    const issued = await issue({ expiresAt: inMinutes(60 * 24) });
    await arrange(
      `update credential_delivery_job set state = 'LEASED', attempt_count = 6, lease_version = 6, lease_owner = 'dw-crashed',
              lease_expires_at = clock_timestamp() - interval '1 second', outcome_class = 'UNKNOWN' where id = $1`,
      [issued.job.id],
    );
    const b = newWorker('dw-b');

    expect(await b.worker.runOnce()).toBe(true);

    expect(b.provider.sends).toEqual([]);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'SCHEDULE_EXHAUSTED',
      attempt_count: 7,
      payload_ciphertext: null,
    });
    expect(
      counter(b.metrics, 'credential_delivery_jobs_failed_total', {
        outcome: 'SCHEDULE_EXHAUSTED',
      }),
    ).toBe(1);
    expect(await b.worker.runOnce()).toBe(false);
    await clearJobs();
  });

  // Break caught: two workers sending the same message because both claimed it.
  it('lets exactly one of two workers that ask at the same moment send a message', async () => {
    const issued = await issue();
    const a = newWorker('dw-a');
    const b = newWorker('dw-b');

    const results = await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);

    expect(results.toSorted()).toEqual([false, true]);
    expect(a.provider.sends.length + b.provider.sends.length).toBe(1);
    expect((await rowOf(issued.job.id)).attempt_count).toBe(1);
    await clearJobs();
  });

  // Break caught: a stale worker overwriting a later outcome (the fence), and doing so without anyone knowing.
  it('refuses the outcome of a worker whose lease was taken over, keeps the later outcome and says so', async () => {
    const issued = await issue();
    const hold = latch();
    const slow = new StoringProvider();
    slow.onArrival = () => hold.promise;
    const a = newWorker('dw-stale', slow);
    const b = newWorker('dw-taker');

    const stale = a.worker.runOnce();
    await until(() => slow.sends.length === 1);
    await endLease(issued.job.id);
    await b.worker.runOnce();
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      lease_owner: 'dw-taker',
    });
    hold.release();
    await stale;

    const row = await rowOf(issued.job.id);
    expect(row).toMatchObject({ state: 'ACCEPTED', lease_owner: 'dw-taker', lease_version: 2 });
    expect(row.provider_message_ref).toMatch(/^(held|ref)-/);
    expect(a.lines().filter((line) => line.msg === 'delivery lease lost')).toHaveLength(1);
    await clearJobs();
  });
});

describe('an unknown outcome: the same message, the same identity (S0.18)', () => {
  // Break caught (timeout, then late acceptance): the worker giving the provider no more time than the timeout and treating its
  // late acceptance as a failure to be sent again as a new message.
  it('waits on the schedule after a timeout, and finds the late acceptance instead of sending again', async () => {
    const issued = await issue();
    const provider = new StoringProvider();
    provider.delayBeforeStoreMs = 400;
    const a = newWorker('dw-a', provider, { providerTimeoutMs: { EMAIL: 150, SMS: 150 } });

    await a.worker.runOnce();
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'RETRYABLE',
      outcome_class: 'UNKNOWN',
    });
    await until(() => provider.sink.messages.size === 1);
    await makeDue(issued.job.id);
    await a.worker.runOnce();

    expect(provider.sends).toHaveLength(1);
    expect(await rowOf(issued.job.id)).toMatchObject({ state: 'ACCEPTED', attempt_count: 2 });
    expect(a.lines().some((line) => line.msg === 'delivery provider answered late')).toBe(true);
    await clearJobs();
  });

  // Break caught (the accepted-but-unacknowledged send, a provider with a status query): the provider keeps the message and the
  // acknowledgement is lost; the retry asks, is told, and nothing new is sent.
  it('reconciles with the provider’s status after a lost acknowledgement, and sends nothing more', async () => {
    const issued = await issue();
    const provider = new StoringProvider();
    provider.answer = () => Promise.resolve({ outcome: 'UNKNOWN' });
    const a = newWorker('dw-a', provider);

    await a.worker.runOnce();
    await makeDue(issued.job.id);
    await a.worker.runOnce();

    expect(provider.sends).toHaveLength(1);
    expect(await rowOf(issued.job.id)).toMatchObject({ state: 'ACCEPTED', attempt_count: 2 });
    await clearJobs();
  });

  // Break caught (the same, with a provider that has no status query): the retry carries the same link and the same delivery identity,
  // nothing new is issued, and a second delivery is tolerated because redemption is single-use.
  it('sends the same message again, with the same link and identity, when the provider cannot say, and issues nothing new', async () => {
    const issued = await issue();
    const provider = new StoringProvider();
    provider.hasStatus = false;
    let answers = 0;
    provider.answer = () => {
      answers += 1;
      return Promise.resolve(
        answers === 1
          ? { outcome: 'UNKNOWN' }
          : { outcome: 'ACCEPTED', providerMessageRef: 'second-ref' },
      );
    };
    const a = newWorker('dw-a', provider);
    const before = await observer.count('credential_delivery_job');

    await a.worker.runOnce();
    await makeDue(issued.job.id);
    await a.worker.runOnce();

    expect(provider.sends).toHaveLength(2);
    expect(provider.sends[1]).toEqual(provider.sends[0]);
    expect(provider.sends[0]?.dedupeId).toBe(issued.job.providerDedupeId);
    expect(provider.sends[0]?.link).toBe(issued.request.link);
    expect(await observer.count('credential_delivery_job')).toBe(before);
    expect(await redemptionState(issued.redemptionId)).toBe('PENDING');
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      attempt_count: 2,
      provider_message_ref: 'second-ref',
    });
    await clearJobs();
  });

  // Break caught: a terminal failure that is not counted: the rejection, and the schedule that ran out after six attempts.
  it('counts a rejection, and a schedule that ran out, as terminal failures', async () => {
    const rejected = await issue();
    const refusing = new StoringProvider();
    refusing.answer = () => Promise.resolve({ outcome: 'REJECTED', outcomeClass: 'REJECTED' });
    const a = newWorker('dw-a', refusing);
    await a.worker.runOnce();
    expect(await rowOf(rejected.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'REJECTED',
    });
    expect(
      counter(a.metrics, 'credential_delivery_jobs_failed_total', { outcome: 'REJECTED' }),
    ).toBe(1);
    await clearJobs();

    const stuck = await issue({ expiresAt: inMinutes(60 * 24) });
    const silent = new StoringProvider();
    silent.hasStatus = false;
    silent.answer = () => Promise.resolve({ outcome: 'UNKNOWN' });
    const b = newWorker('dw-b', silent);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(await b.worker.runOnce()).toBe(true);
      if (attempt < 6) await makeDue(stuck.job.id);
    }

    expect(await rowOf(stuck.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'SCHEDULE_EXHAUSTED',
      attempt_count: 6,
      payload_ciphertext: null,
    });
    expect(
      counter(b.metrics, 'credential_delivery_jobs_failed_total', {
        outcome: 'SCHEDULE_EXHAUSTED',
      }),
    ).toBe(1);
    expect(
      counter(b.metrics, 'credential_delivery_attempts_total', {
        channel: 'EMAIL',
        result: 'UNKNOWN',
      }),
    ).toBe(6);
    await clearJobs();
  });
});

describe('cancellation and a record that cannot be read (S0.18)', () => {
  const consume = (redemptionId: string, cancel: boolean, request: DeliveryRequest) =>
    withHandle(api.service, ISSUER, async (handle, tx) => {
      await tx.execute(
        sql`update delivery_fixture_redemption set state = 'CONSUMED' where id = ${redemptionId}`,
      );
      if (cancel) await queue.cancel(handle, { by: 'redemption', redemption: request.redemption });
    });

  // Break caught: a message sent for a credential that was consumed or superseded before the worker looked.
  it('sends nothing for a job cancelled in the transaction that consumed its record', async () => {
    const issued = await issue();
    await consume(issued.redemptionId, true, issued.request);
    const a = newWorker('dw-a');

    expect(await a.worker.runOnce()).toBe(false);

    expect(a.provider.sends).toEqual([]);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'CANCELLED',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: the worker trusting its claim and not looking at the record again: the job was not cancelled (an issuing path that
  // forgot to), but the record is closed, and the message is not sent.
  it('reads the record again and sends nothing when it has closed without the job being cancelled', async () => {
    const issued = await issue();
    await consume(issued.redemptionId, false, issued.request);
    const a = newWorker('dw-a');

    expect(await a.worker.runOnce()).toBe(true);

    expect(a.provider.sends).toEqual([]);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'CANCELLED',
      outcome_class: 'CANCELLED',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: a cancellation after the send began being overwritten by the worker's acceptance: the send is dead because
  // redemption refuses the record, the job stays cancelled, and the worker says it lost the lease.
  it('keeps a job cancelled while its message was in flight cancelled, and tolerates the message', async () => {
    const issued = await issue();
    const hold = latch();
    const provider = new StoringProvider();
    provider.onArrival = () => hold.promise;
    const a = newWorker('dw-a', provider);

    const working = a.worker.runOnce();
    await until(() => provider.sends.length === 1);
    await consume(issued.redemptionId, true, issued.request);
    hold.release();
    await working;

    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'CANCELLED',
      provider_message_ref: null,
    });
    expect(a.lines().some((line) => line.msg === 'delivery lease lost')).toBe(true);
    expect(provider.sends).toHaveLength(1);
    await clearJobs();
  });

  // Break caught: a message destroyed because the worker that claimed it had not been given the key it is sealed under (a rotation the
  // fleet has not finished): nothing is sent, the ciphertext stays, the log says so without a word of the payload, and the job waits
  // on the schedule for a worker that can open it.
  it('keeps a job sealed under a key version it does not hold, and says so once', async () => {
    const issued = await issue();
    await arrange(`update credential_delivery_job set payload_key_version = 7 where id = $1`, [
      issued.job.id,
    ]);
    const a = newWorker('dw-a');

    expect(await a.worker.runOnce()).toBe(true);

    expect(a.provider.sends).toEqual([]);
    const row = await rowOf(issued.job.id);
    expect(row).toMatchObject({ state: 'RETRYABLE', outcome_class: 'PAYLOAD_DEFERRED' });
    expect(row.payload_ciphertext).not.toBeNull();
    expect(
      a.lines().filter((line) => line.msg === 'delivery payload is not one this worker can open'),
    ).toHaveLength(1);
    expect(a.text()).not.toContain(SENTINEL_TOKEN);
    expect(a.text()).not.toContain(SENTINEL_DESTINATION);
    await clearJobs();
  });

  // Break caught: a record that cannot be confirmed (no reader exists yet) being taken for pending: nothing is sent, and the job waits
  // on the schedule instead of failing.
  it('sends nothing while it cannot confirm the record, and waits on the schedule', async () => {
    const issued = await issue();
    const a = newWorker('dw-a', new StoringProvider(), {}, UNBUILT_REDEMPTION_READER);

    await a.worker.runOnce();

    expect(a.provider.sends).toEqual([]);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'RETRYABLE',
      outcome_class: 'REDEMPTION_UNCONFIRMED',
    });
    await clearJobs();
  });
});

// G2-03. A worker that has not been given a key, an envelope or a layout version (a rotation or a release under way) cannot open a
// payload another worker can. That is an operational compatibility problem: the message is live, and no provider has been asked.
describe('a worker that cannot open a payload another worker can (G2-03)', () => {
  const keyOf = (keys: PurposeKeys, version: number) => {
    const held = keys.versions[version];
    if (held === undefined) throw new Error(`no key ${String(version)}`);
    return held;
  };
  // The issuing side seals under version 2; the old worker holds version 1 only; the new one holds both.
  const bothKeys = purposeKeys([1, 2]);
  const oldKeys: PurposeKeys = { activeVersion: 1, versions: { 1: keyOf(bothKeys, 1) } };
  const queueOver = (keys: PurposeKeys) =>
    new PostgresDeliveryQueue({
      cipher: new AesGcmSecretCipher(localKeys({ credential_delivery: keys })),
      clock,
      work: work.service,
      random: () => 0.5,
    });
  let issuing: PostgresDeliveryQueue;
  let incompatible: PostgresDeliveryQueue;
  let compatible: PostgresDeliveryQueue;
  // The shared setup above has built the database by now; these queues need its worker's service.
  beforeAll(() => {
    issuing = queueOver(bothKeys);
    incompatible = queueOver(oldKeys);
    compatible = queueOver(bothKeys);
  });

  const secondsToNext = async (id: string): Promise<number> =>
    (
      await observer.one<{ seconds: number }>(
        `select extract(epoch from (next_attempt_at - clock_timestamp()))::float8 as seconds
           from credential_delivery_job where id = $1`,
        [id],
      )
    )?.seconds ?? Number.NaN;

  // Break caught: the ordinary retry schedule used for a refusal that is the worker's own. It spent a send for every claim, so six claims
  // by a worker that cannot open the payload ended the job (and erased the message) without a provider ever being asked.
  it('defers a job again and again without destroying it or spending a send, and a compatible worker then sends the same message', async () => {
    const issued = await issue({ expiresAt: inMinutes(60 * 24) }, issuing);
    const early = newWorker('dw-old', new StoringProvider(), { queue: incompatible });

    for (let claim = 1; claim <= 9; claim += 1) {
      expect(await early.worker.runOnce()).toBe(true);
      const row = await rowOf(issued.job.id);
      expect(row, `after claim ${String(claim)}`).toMatchObject({
        state: 'RETRYABLE',
        outcome_class: 'PAYLOAD_DEFERRED',
        attempt_count: claim,
        deferred_claims: claim,
      });
      expect(row.payload_ciphertext).not.toBeNull();
      await makeDue(issued.job.id);
    }

    expect(early.provider.sends).toEqual([]);
    expect(
      counter(early.metrics, 'credential_delivery_jobs_deferred_total', {
        reason: 'PAYLOAD_NOT_HELD',
      }),
    ).toBe(9);
    expect(early.text()).not.toContain(SENTINEL_TOKEN);
    expect(early.text()).not.toContain(SENTINEL_DESTINATION);

    const late = newWorker('dw-new', new StoringProvider(), { queue: compatible });
    expect(await late.worker.runOnce()).toBe(true);
    // The same job, the same payload, the same deduplication identity; and nothing to ask the provider about, for none was sent.
    expect(late.provider.statusAsked).toEqual([]);
    expect(late.provider.sends).toEqual([
      {
        dedupeId: issued.job.providerDedupeId,
        kind: 'SETUP_GRANT',
        channel: 'EMAIL',
        destination: SENTINEL_DESTINATION,
        link: issued.request.link,
      },
    ]);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      attempt_count: 10,
      deferred_claims: 9,
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: no wait between deferrals (a busy loop of claims on one job), or a wait that grows without bound.
  it('backs off between deferrals, from half a minute to a cap, and a job just deferred is not due again at once', async () => {
    const issued = await issue({ expiresAt: inMinutes(60 * 24) }, issuing);
    const early = newWorker('dw-old', new StoringProvider(), { queue: incompatible });
    const waits: number[] = [];

    for (let claim = 1; claim <= 8; claim += 1) {
      await early.worker.runOnce();
      waits.push(Math.round((await secondsToNext(issued.job.id)) / 5) * 5);
      expect(await early.worker.runOnce()).toBe(false);
      await makeDue(issued.job.id);
    }

    expect(waits).toEqual([30, 60, 120, 240, 480, 600, 600, 600]);
    await clearJobs();
  });

  // Break caught: a deferral that ends the job because its next attempt would fall after the credential's end, before the credential
  // has ended; or a payload erased at any moment but the end of the credential.
  it('leaves a deferred job to the end of its credential, which ends it and erases the payload, and not before', async () => {
    const issued = await issue({ expiresAt: new Date(Date.now() + 40_000) }, issuing);
    const early = newWorker('dw-old', new StoringProvider(), { queue: incompatible });

    await early.worker.runOnce();
    await makeDue(issued.job.id);
    await early.worker.runOnce();
    await makeDue(issued.job.id);
    await early.worker.runOnce();

    // The wait of the third deferral falls past the credential's end: the job waits for that end, it does not fail early.
    const waiting = await rowOf(issued.job.id);
    expect(waiting).toMatchObject({ state: 'RETRYABLE', outcome_class: 'PAYLOAD_DEFERRED' });
    expect(waiting.payload_ciphertext).not.toBeNull();
    expect(await secondsToNext(issued.job.id)).toBeGreaterThan(40);

    await arrange(
      `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
              created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
      [issued.job.id],
    );
    expect(await new RetentionCleanup({ database: work.service, clock }).runOnce()).toMatchObject({
      jobsExpired: 1,
    });
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'EXPIRED',
      outcome_class: 'EXPIRED',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: a deferral that makes a job wait for a credential that ended while the worker held the claim: the job would sit in
  // RETRYABLE with a token that must already be gone. The deferral is judged on the database's clock, in the statement, and ends it.
  it('ends a job whose credential ended while the claim was held, and erases the payload, rather than deferring it', async () => {
    const issued = await issue({ expiresAt: inMinutes(60) }, issuing);
    const caught = await incompatible.claim('dw-old', 30_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(UnreadableClaimError);
    await arrange(
      `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
              created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
      [issued.job.id],
    );

    const end = await incompatible.recordOutcome((caught as UnreadableClaimError).leased, {
      outcome: 'PAYLOAD_DEFERRED',
    });

    expect(end).toEqual({ state: 'EXPIRED', outcomeClass: 'EXPIRED' });
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'EXPIRED',
      outcome_class: 'EXPIRED',
      attempt_count: 1,
      deferred_claims: 0,
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: a cancellation not reaching a deferred job, or the deferral writing over it.
  it('lets the operation that consumed the record cancel a deferred job, which erases its payload', async () => {
    const issued = await issue({ expiresAt: inMinutes(60) }, issuing);
    await newWorker('dw-old', new StoringProvider(), { queue: incompatible }).worker.runOnce();
    expect((await rowOf(issued.job.id)).state).toBe('RETRYABLE');

    await withHandle(api.service, ISSUER, (handle) =>
      queue.cancel(handle, { by: 'redemption', redemption: issued.request.redemption }),
    );

    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'CANCELLED',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: a claim that the worker could not use being handed back as free. A claim by a worker that crashes before it records
  // anything is an attempt that may have sent; only a deferral that was recorded gives its claim back.
  it('counts a claim that was never recorded as an attempt, and asks the provider about it before sending', async () => {
    const issued = await issue({ expiresAt: inMinutes(60) }, issuing);
    const claim = await incompatible.claim('dw-crashed', 30_000).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(claim).toBeInstanceOf(UnreadableClaimError);
    expect((claim as UnreadableClaimError).reason).toBe('NOT_HELD');
    await endLease(issued.job.id);

    const late = newWorker('dw-new', new StoringProvider(), { queue: compatible });
    expect(await late.worker.runOnce()).toBe(true);

    expect(late.provider.statusAsked).toEqual([issued.job.providerDedupeId]);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      attempt_count: 2,
      deferred_claims: 0,
    });
    await clearJobs();
  });

  // Break caught: the bound on sends dropped, or counted from claims again: the sixth send is the last, however many deferrals came
  // before it, and a deferral gives back its own claim and no other.
  it.each([
    [8, 3, 'sixth', 'sends'],
    [9, 3, 'seventh', 'ends'],
  ] as const)(
    'with %i claims and %i deferrals before it, the next claim is the job’s %s send, which %s',
    async (claims, deferrals, _which, result) => {
      const issued = await issue({ expiresAt: inMinutes(60 * 24) }, issuing);
      await arrange(
        `update credential_delivery_job set state = 'LEASED', attempt_count = $2, deferred_claims = $3, lease_version = $2,
                lease_owner = 'dw-crashed', lease_expires_at = clock_timestamp() - interval '1 second', outcome_class = 'UNKNOWN'
          where id = $1`,
        [issued.job.id, claims, deferrals],
      );
      const late = newWorker('dw-new', new StoringProvider(), { queue: compatible });

      await late.worker.runOnce();

      expect(late.provider.sends).toHaveLength(result === 'sends' ? 1 : 0);
      expect((await rowOf(issued.job.id)).state).toBe(result === 'sends' ? 'ACCEPTED' : 'FAILED');
      await clearJobs();
    },
  );
});

describe('the lanes and the shutdown over a real queue (S0.18)', () => {
  // Break caught: lanes that do not work through a backlog, or that send a message twice when several of them ask at once.
  it('works through a backlog on several lanes, each message once', async () => {
    const jobs = [];
    for (let index = 0; index < 8; index += 1) jobs.push(await issue());
    const provider = new StoringProvider();
    provider.delayBeforeStoreMs = 30;
    const a = newWorker('dw-lanes', provider, { concurrency: 4 });

    a.worker.start();
    await until(
      async () =>
        (await observer.count('credential_delivery_job', { state: 'ACCEPTED' })) === jobs.length,
    );
    const report = await a.worker.stop(2_000);

    expect(provider.sends).toHaveLength(8);
    expect(new Set(provider.sends.map((message) => message.dedupeId)).size).toBe(8);
    expect(report).toMatchObject({ relinquished: 0, unconfirmed: 0 });
    await clearJobs();
  });

  // Break caught: a stop that leaves a lease held when it could give it back: the job is due again at once for the next worker, with
  // the attempt counted and nothing held against the provider.
  it('gives back the lease of a job still in flight at the shutdown, and the next worker takes it at once', async () => {
    const issued = await issue();
    const hold = latch();
    const provider = new StoringProvider();
    provider.onArrival = () => hold.promise;
    const a = newWorker('dw-stopping', provider, {
      providerTimeoutMs: { EMAIL: 20_000, SMS: 20_000 },
    });
    a.worker.start();
    await until(() => provider.sends.length === 1);

    const report = await a.worker.stop(1_500);

    expect(report).toEqual({ drained: 0, relinquished: 1, unconfirmed: 0 });
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'RETRYABLE',
      outcome_class: 'RELINQUISHED',
      attempt_count: 1,
    });
    hold.release();
    const b = newWorker('dw-next');
    expect(await b.worker.runOnce()).toBe(true);
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      attempt_count: 2,
      lease_owner: 'dw-next',
    });
    await clearJobs();
  });
});

describe('the worker’s own login, under a budget (OB-57, OB-58)', () => {
  // Break caught: a worker whose statement outlives its budget (the budget would only stop the waiting, and the statement and its
  // transaction would go on in the database), or whose login cannot cancel its own session.
  it('cancels a running statement of its own when the job’s budget runs out, as melarc_worker_runtime', async () => {
    const budget = new ExecutionBudget(clock, 'delivery-job', 400);
    let pid = 0;
    const outcome = await runWithBudget(budget, () =>
      work.service
        .transactionWithContext(systemContext('credential_delivery'), async (tx) => {
          const result = await tx.execute(sql`select pg_backend_pid() as pid`);
          pid = Number((result.rows[0] as { pid: number | string }).pid);
          await tx.execute(sql`select pg_sleep(30)`);
        })
        .then(
          () => 'completed',
          (error: unknown) => error,
        ),
    );
    budget.finish();

    expect(outcome).toBeInstanceOf(BudgetExpiredError);
    await until(
      async () =>
        (
          await observer.one<{ n: number }>(
            'select count(*)::int as n from pg_stat_activity where pid = $1',
            [pid],
          )
        )?.n === 0,
    );
  });

  // Break caught: the worker's sessions not identifiable by name, so that an operator cannot tell them from the API's.
  it('names its sessions after the worker', async () => {
    await work.service.transactionWithContext(systemContext('credential_delivery'), async (tx) => {
      await tx.execute(sql`select 1`);
    });
    const names = await observer.rows<{ application_name: string }>(
      `select distinct application_name from pg_stat_activity where datname = $1 and usename = $2`,
      [database.name, WORKER_RUNTIME_ROLE],
    );
    expect(names.map((row) => row.application_name)).toEqual([WORKER_APPLICATION]);
  });
});
