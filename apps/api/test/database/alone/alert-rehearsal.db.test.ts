// Runs alone: it starts the attestation verifier's JVM and waits up to a minute and a quarter for that service to read its roots again.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import type { DeliveryProvider } from '../../../src/platform/auth/ports/delivery-provider.port.js';
import type {
  DeliveryOutcome,
  DeliveryRequest,
} from '../../../src/platform/auth/ports/delivery-queue.port.js';
import { API_RUNTIME_ROLE } from '../../../src/platform/config/load-config.js';
import type { SecurityContext } from '../../../src/platform/database/transaction-context.js';
import { WORKER_RUNTIME_ROLE } from '../../../src/platform/database/technical-roles.js';
import { PostgresDeliveryQueue } from '../../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { DeliveryWorker } from '../../../src/platform/delivery/worker/delivery-worker.js';
import type {
  RedemptionRecordReader,
  RedemptionStanding,
} from '../../../src/platform/delivery/worker/redemption-record-reader.js';
import { WorkerJobStore } from '../../../src/platform/delivery/worker/worker-job-store.js';
import { createServiceLogger } from '../../../src/platform/logging/create-logger.js';
import {
  ALERT_RULES,
  firingAlerts,
  parseExposition,
  type Scrape,
} from '../../../src/platform/metrics/alert-rules.js';
import { BoundedMetrics } from '../../../src/platform/metrics/bounded.metrics.adapter.js';
import type { MetricsListener } from '../../../src/platform/metrics/metrics-listener.js';
import { startProcessMetrics } from '../../../src/platform/metrics/process-metrics.js';
import { localKeys } from '../../../src/test-support/key-config.js';
import { closeAll } from '../../support/teardown.js';
import { openAdmin, type Admin } from '../support/admin.js';
import { withHandle } from '../support/handle.js';
import { observe, type Observer } from '../support/observe.js';
import { PRINCIPAL_1, systemContext } from '../support/rls-fixture.js';
import { buildService, type BuiltService } from '../support/service.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  startVerifierService,
  stopEveryVerifier,
  type RunningVerifier,
} from '../support/verifier-service.js';

/**
 * The rehearsal of the alerts of the credential path and of the attestation trust data (S0.68; OBSERVABILITY_AND_RECOVERY.md section 3;
 * SLICE-000 section 7 item 6). The alerts are the rules of `alert-rules.ts`, and they are fed **real readings**: the delivery worker's
 * private metrics endpoint, served over HTTP by the code the worker process runs (`startProcessMetrics`, the bounded registry, the
 * queue's backlog gauge) while a real worker delivers real queued messages on a real database, and the attestation verifier's own
 * `GET /v1/metrics`, from the real service.
 *
 * - **A deliberately failed credential message**: a provider that refuses every message; five messages fail terminally and the
 *   *Credential delivery* (a security dead letter) and *Provider down* (five failures in a row, at any volume) alerts fire, and the
 *   percentage rules do not, below the 20 attempts of section 3.2a.
 * - **A lease that ended with no outcome** (a worker that crashed mid-send, arranged as the worker tests arrange it): another worker takes
 *   the message over, and the expired-lease condition fires.
 * - **The backlog**: the gauge reads the age of the oldest due message from the queue, as the database reckons it. Its thresholds are
 *   minutes long (more than 2 for 15, more than 10), and they are proved on the rules' own tests, not waited out here.
 * - **Trust data that cannot be loaded**: the verifier's accepted roots are made unreadable while it runs; within a minute it fails to load
 *   them, its counter says so, and the trust-data alert fires at SEV-2. The 12- and 24-hour ages are measured by the verifier from the
 *   held list's fetch time on its own clock (`TrustData.kt`, held by its tests); here the rules are shown to read the verifier's series
 *   as it serves them, and to fire on that reading at each age.
 */

const clock = new SystemClock();
const ISSUER: SecurityContext = systemContext('authentication');
const AGE = 'credential_delivery_oldest_due_age_seconds';
const quiet = { info: () => undefined, warn: () => undefined };
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

let database: TestDatabase;
let api: BuiltService;
let work: BuiltService;
let admin: Admin;
let observer: Observer;
let queue: PostgresDeliveryQueue;
const cipher = new AesGcmSecretCipher(localKeys());
const metrics = new BoundedMetrics({ policy: 'throw', clock });
let endpoint: MetricsListener;
const workers: DeliveryWorker[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  api = buildService(database, { poolMax: 4 });
  work = buildService(database, { poolMax: 6, login: WORKER_RUNTIME_ROLE });
  admin = await openAdmin(database);
  observer = await observe(database);
  await admin.query(`create table public.rehearsal_redemption (
      id uuid primary key, state text not null, expires_at timestamptz not null)`);
  await admin.query('alter table public.rehearsal_redemption owner to melarc_owner');
  await admin.query(`grant select, insert on public.rehearsal_redemption to ${API_RUNTIME_ROLE}`);
  queue = new PostgresDeliveryQueue({ cipher, clock, work: work.service, random: () => 0.5 });
  // The worker's endpoint, as the worker process composes it: its registry, and the queue's backlog read at each request.
  const backlog = new WorkerJobStore({ database: work.service, cipher, clock });
  const started = await startProcessMetrics({
    endpoint: { host: '127.0.0.1', port: 0 },
    source: metrics,
    gauges: async () => [{ name: AGE, value: await backlog.oldestDueAgeSeconds() }],
    logger: quiet,
  });
  if (started === undefined) throw new Error('the endpoint did not start');
  endpoint = started;
});

afterAll(async () => {
  // A beforeAll that failed part-way leaves some of these unset: each is closed if it exists, in spite of the others, the database last.
  await closeAll([
    ...workers.map((worker) => () => worker.stop(500).catch(() => undefined)),
    () => (endpoint as MetricsListener | undefined)?.close(),
    () => (admin as Admin | undefined)?.close(),
    () => (observer as Observer | undefined)?.close(),
    () => (api as BuiltService | undefined)?.close(),
    () => (work as BuiltService | undefined)?.close(),
    () => (database as TestDatabase | undefined)?.drop(),
  ]);
});

/** One reading of an endpoint, as a scraper takes it. */
async function scrape(url: string, instance: string): Promise<Scrape> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return { at: Date.now(), instance, samples: parseExposition(await response.text()) };
}
const scrapeWorker = () => scrape(`http://127.0.0.1:${String(endpoint.port)}/metrics`, 'worker');

const firing = (history: readonly Scrape[]): string[] =>
  firingAlerts(history)
    .map((rule) => rule.id)
    .toSorted();

/** The redemption record as the worker reads it. */
class RehearsalReader implements RedemptionRecordReader {
  async standing(record: { readonly id: string }): Promise<RedemptionStanding> {
    const row = await observer.one<{ standing: RedemptionStanding }>(
      `select case when state = 'PENDING' and expires_at > clock_timestamp() then 'PENDING' else 'CLOSED' end as standing
         from rehearsal_redemption where id = $1`,
      [record.id],
    );
    return row?.standing ?? 'CLOSED';
  }
}

/** A provider that answers as it is told, and can hold a send until it is released. */
class Provider implements DeliveryProvider {
  answer: () => Promise<DeliveryOutcome> = () =>
    Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: null });
  hold: Promise<unknown> = Promise.resolve();
  async send(): Promise<DeliveryOutcome> {
    await this.hold;
    return this.answer();
  }
  status(): Promise<DeliveryOutcome | null> {
    return Promise.resolve(null);
  }
}

function startWorker(
  name: string,
  provider: Provider,
  registry: BoundedMetrics = metrics,
): DeliveryWorker {
  const worker = new DeliveryWorker({
    queue,
    providers: { EMAIL: provider, SMS: provider },
    providerTimeoutMs: { EMAIL: 2_000, SMS: 2_000 },
    redemption: new RehearsalReader(),
    clock,
    logger: createServiceLogger({
      service: 'melarc-delivery-worker',
      level: 'error',
      appEnv: 'local',
    }),
    metrics: registry,
    workerId: name,
    concurrency: 1,
    pollIntervalMs: 100,
    leaseMs: 30_000,
    jobBudgetMs: 25_000,
  });
  workers.push(worker);
  worker.start();
  return worker;
}

/** What an issuing operation does: write the redemption record and queue its message, in one transaction of the API. */
async function issue(): Promise<string> {
  const request: DeliveryRequest = {
    kind: 'SETUP_GRANT',
    redemption: { type: 'SETUP_GRANT', id: randomUUID() },
    principal: { type: 'STAFF', id: PRINCIPAL_1 },
    channel: 'EMAIL',
    destination: 'rehearsal.recipient@example.test',
    link: `https://ops.example.test/setup/credential#token=${randomUUID()}`,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  };
  const job = await withHandle(api.service, ISSUER, async (handle, tx) => {
    await tx.execute(
      sql`insert into rehearsal_redemption (id, state, expires_at)
          values (${request.redemption.id}, 'PENDING', ${request.expiresAt.toISOString()}::timestamptz)`,
    );
    return queue.enqueue(handle, request);
  });
  return job.id;
}

async function until(condition: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await sleep(100);
  }
}

const states = async (ids: readonly string[]): Promise<string[]> =>
  (
    await observer.rows<{ state: string }>(
      `select state from credential_delivery_job where id = any($1::uuid[]) order by id`,
      [ids],
    )
  ).map((row) => row.state);

describe('the credential path (OBSERVABILITY_AND_RECOVERY.md section 3, Credential delivery and Provider down)', () => {
  // Break caught: a backlog gauge that reads something other than the queue (always zero, the newest message, a time on the app's clock).
  it('reads the age of the oldest due message from the queue, and zero once it is delivered', async () => {
    const first = await issue();
    await sleep(1_500);
    const second = await issue();
    const reading = (await scrapeWorker()).samples.get(AGE) ?? -1;
    const truth = await observer.one<{ age: number }>(
      `select extract(epoch from clock_timestamp() - min(created_at))::float8 as age from credential_delivery_job where id = any($1::uuid[])`,
      [[first, second]],
    );
    expect(reading).toBeGreaterThan(1.4);
    expect(Math.abs(reading - (truth?.age ?? 0))).toBeLessThan(1);
    expect(firing([await scrapeWorker()])).toEqual([]);

    const delivering = startWorker('rehearsal-delivers', new Provider());
    await until(
      async () => (await states([first, second])).every((state) => state === 'ACCEPTED'),
      10_000,
      'the delivery',
    );
    await delivering.stop(1_000);
    expect((await scrapeWorker()).samples.get(AGE)).toBe(0);
  });

  // Break caught: a terminal failure or a provider outage that changes a counter no alert reads, or an alert that judges a
  // percentage on five attempts.
  it('fires the dead-letter and the five-in-a-row alerts on messages a provider refused, and no percentage rule below 20 attempts', async () => {
    const before = await scrapeWorker();
    const refusing = new Provider();
    refusing.answer = () => Promise.resolve({ outcome: 'REJECTED', outcomeClass: 'REJECTED' });
    const jobs: string[] = [];
    for (let index = 0; index < 5; index += 1) jobs.push(await issue());
    const worker = startWorker('rehearsal-refused', refusing);
    await until(
      async () => (await states(jobs)).every((state) => state === 'FAILED'),
      15_000,
      'five terminal failures',
    );
    await worker.stop(1_000);
    const after = await scrapeWorker();

    expect(after.samples.get('credential_delivery_jobs_failed_total{outcome="REJECTED"}')).toBe(5);
    expect(firing([before, after])).toEqual([
      'credential_delivery_terminal_failure',
      'provider_down_email_consecutive_failures',
    ]);
  });

  // Break caught: a message taken over from a worker that left no outcome, counted nowhere an alert reads.
  it('fires the expired-lease alert when a message whose lease ended with no outcome is taken over', async () => {
    const before = await scrapeWorker();
    const crashed = new Provider();
    let release: () => void = () => undefined;
    crashed.hold = new Promise<void>((done) => {
      release = done;
    });
    const job = await issue();
    const stuck = startWorker(
      'rehearsal-crashed',
      crashed,
      new BoundedMetrics({ policy: 'throw', clock }),
    );
    await until(async () => (await states([job]))[0] === 'LEASED', 5_000, 'the claim');
    // The worker that holds it is gone: its lease is made to have ended, as the worker tests arrange a crash.
    await admin.query(
      'alter table credential_delivery_job disable trigger credential_delivery_job_guard',
    );
    try {
      await admin.query(
        `update credential_delivery_job set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
        [job],
      );
    } finally {
      await admin.query(
        'alter table credential_delivery_job enable trigger credential_delivery_job_guard',
      );
    }
    const taking = startWorker('rehearsal-takes-over', new Provider());
    await until(async () => (await states([job]))[0] === 'ACCEPTED', 10_000, 'the take-over');
    await taking.stop(1_000);
    release();
    await stuck.stop(1_000);
    const after = await scrapeWorker();

    expect(after.samples.get('credential_delivery_leases_expired_total')).toBe(1);
    expect(firing([before, after])).toContain('credential_delivery_lease_expired');
  });
});

describe('the attestation trust data (OBSERVABILITY_AND_RECOVERY.md section 3, Attestation trust data aging)', () => {
  interface Vectors {
    readonly service: {
      readonly package_name: string;
      readonly signing_digests: readonly string[];
      readonly accepted_roots: readonly string[];
      readonly revoked_serials: readonly string[];
    };
  }
  const vectors = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../vectors/attestation-chains.v1.json'), 'utf8'),
  ) as Vectors;
  let verifier: RunningVerifier;
  const scrapeVerifier = () => scrape(`${verifier.url}/v1/metrics`, 'verifier-1');

  beforeAll(async () => {
    verifier = await startVerifierService({
      packageName: vectors.service.package_name,
      signingDigests: vectors.service.signing_digests,
      acceptedRoots: vectors.service.accepted_roots,
      revokedSerials: vectors.service.revoked_serials,
    });
    // Longer than the service's own wait for READY (ninety seconds), so that this hook never gives up on a service that is still starting.
  }, 120_000);
  afterAll(async () => {
    // Every service started here, including one this hook never received because it gave up first.
    await stopEveryVerifier();
  });

  // Break caught: rules written against a series name, a label or a unit the verifier does not serve, which would never fire.
  it('reads the verifier’s own series, quiet while the data is fresh, and fires at each age the document names', async () => {
    const fresh = await scrapeVerifier();
    expect(fresh.samples.get('attestation_trust_data_age_seconds')).toBeLessThan(600);
    // The verifier serves a counter once it has moved (`Telemetry.kt`): absent is zero, to the rules as to this check.
    expect(fresh.samples.get('attestation_trust_roots_load_failures_total') ?? 0).toBe(0);
    expect(firing([fresh])).toEqual([]);

    const aged = (hours: number): Scrape => ({
      ...fresh,
      samples: new Map([
        ...fresh.samples,
        ['attestation_trust_data_age_seconds', hours * 3600 + 1],
      ]),
    });
    expect(firing([aged(12)])).toEqual(['attestation_trust_data_aging_warning']);
    expect(firing([aged(24)])).toEqual([
      'attestation_trust_data_aging_critical',
      'attestation_trust_data_aging_warning',
    ]);
  });

  // Break caught: roots that cannot be loaded, which fail every new enrolment closed, with no alert that says so.
  it('fires at SEV-2 within a minute of the accepted roots becoming unloadable, on the verifier’s own count', async () => {
    const before = await scrapeVerifier();
    writeFileSync(verifier.rootsFile, 'these are not the accepted roots');
    let after = before;
    await until(
      async () => {
        after = await scrapeVerifier();
        return (after.samples.get('attestation_trust_roots_load_failures_total') ?? 0) > 0;
      },
      80_000,
      'the failed reload of the roots',
    );
    const critical = ALERT_RULES.find(
      (rule) => rule.id === 'attestation_trust_data_aging_critical',
    );
    expect(critical?.severity).toBe('SEV-2');
    expect(firing([before, after])).toContain('attestation_trust_data_aging_critical');
  }, 100_000); // The service looks at its roots file once a minute (`TrustData.kt`): the wait is that minute and its margin, not a guess.
});
