// Runs alone: it measures time, so it must have the machine to itself; and it is skipped unless MELARC_BENCHMARK=1.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Argon2Hasher } from '../../../src/platform/auth/crypto/argon2.hasher.adapter.js';
import { normaliseNewCredential } from '../../../src/platform/auth/credentials/credential-rule.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../../src/platform/config/load-config.js';
import { validEnv } from '../../../src/test-support/config-env.js';
import {
  environmentRecord,
  type EnvironmentRecord,
} from '../../../src/tools/benchmark/argon2-benchmark.js';
import {
  saturation,
  sharedAddressNeed,
  stageResult,
  type StageResult,
} from '../../../src/tools/benchmark/capacity-model.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import { freePort, killAll, start, type RunningProcess } from '../../support/api-process.js';
import { buildRelease } from '../../support/policy-release.js';
import { closeAll } from '../../support/teardown.js';
import { insertStaff, staffRow } from '../support/identities.js';
import { seedReferenceData } from '../support/seeded.js';
import { clientFor, createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * The integrated capacity measurement of the slice (S0.65; OBSERVABILITY_AND_RECOVERY.md sections 5.1 to 5.5a; contracts/settings.md
 * section 9): the compiled API as its own process, as the runtime login, over a real PostgreSQL, loaded by this process over real HTTP. It
 * measures, on a recorded machine, and proposes nothing as a setting: the staff sign-in (an Argon2id verification behind hash admission,
 * the policy locks and a session issue), an authenticated read, and a refusal at the guard (the rate limit and the authentication step),
 * each at rising concurrency; the size of the session answer as the number of hubs rises; and what the figures mean for people who share
 * one address. `MELARC_BENCHMARK=1` runs it and `MELARC_BENCHMARK_OUTPUT=<file>` names where the figures are written as JSON; without the
 * first it is skipped, and it asserts only that the measurement is sound (every request answered, none lost to the harness), never a speed.
 */

const ENABLED = process.env.MELARC_BENCHMARK === '1';
const OUTPUT = process.env.MELARC_BENCHMARK_OUTPUT;
const OPS_ORIGIN = 'http://127.0.0.1:5173';
const API = '/api/v1';
const PASSWORD = 'The benchmark staff walk the long way 2026';
const SIGN_IN_STAGES = [1, 2, 4, 8, 16, 32, 64] as const;
const READ_STAGES = [1, 4, 16, 64] as const;
const HUB_COUNTS = [1, 10, 100, 1000] as const;
const READERS = 24;
const READ_REQUESTS = 400;

/**
 * What a run may vary to answer a question about a setting: the hash slots and the libuv pool they run on. Nothing else of the
 * environment is taken from the caller; a run without them measures the settings as they are.
 */
const TRIED = Object.fromEntries(
  [
    ['HASH_ADMISSION_SLOTS', process.env.MELARC_BENCHMARK_HASH_SLOTS],
    ['UV_THREADPOOL_SIZE', process.env.MELARC_BENCHMARK_THREADPOOL],
  ].filter((entry): entry is [string, string] => /^\d{1,3}$/.test(entry[1] ?? '')),
);
const env = validEnv({
  NODE_ENV: 'production',
  APP_ENV: 'local',
  ...(TRIED.HASH_ADMISSION_SLOTS === undefined
    ? {}
    : { HASH_ADMISSION_SLOTS: TRIED.HASH_ADMISSION_SLOTS }),
});
const config = (() => {
  const loaded = loadConfig(env);
  if (!loaded.ok) throw new Error('the configuration was refused');
  return loaded.config;
})();

let database: TestDatabase;
let admin: ReturnType<typeof clientFor>;
let api: RunningProcess;
let baseUrl = '';
let currentMain = '';
const staffEmails: string[] = [];

interface Report {
  environment: EnvironmentRecord;
  postgres: string;
  settings: Record<string, unknown>;
  signIn: Measured[];
  signInSaturation: number | null;
  read: Measured[];
  refusedAtTheGuard: Measured[];
  apiFailures: Record<string, number>;
  oneSessionPastTheLimit: { requests: number; answers: Record<string, number>; medianMs: number };
  sessionAnswerByHubs: { hubs: number; bytes: number; medianMs: number }[];
  sharedAddress: {
    people: number;
    windowMinutes: number;
    signInsPerMinute: number;
    shareOfCapacity: number;
  }[];
}
const report: Partial<Report> = {};

beforeAll(async () => {
  if (!ENABLED) return;
  currentMain = buildRelease('current', []);
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  const hasher = new Argon2Hasher(
    config.keys,
    config.credentialHashing.profile,
    config.credentialHashing.acceptedProfiles,
  );
  const checked = normaliseNewCredential(PASSWORD);
  if (!checked.ok) throw new Error('the arranged password is not one a person could set');
  const credentialHash = await hasher.hash('STAFF_PASSWORD', checked.credential);
  // As many staff as requests the sign-in stages send: one sign-in each, so that no per-identity bound decides the figures.
  const total = SIGN_IN_STAGES.reduce((sum, level) => sum + Math.max(30, level * 3), 0);
  for (let index = 0; index < total + 1; index += 1) {
    const row = await insertStaff(
      admin,
      staffRow({ roleBundleId: BUNDLE_IDS.opsStaff, credentialHash, credentialGeneration: 1 }),
    );
    staffEmails.push(row.workEmail);
  }
  const port = await freePort();
  api = start(currentMain, {
    ...env,
    HTTP_PORT: String(port),
    DATABASE_URL: database.urlFor(API_RUNTIME_ROLE),
    ...(TRIED.UV_THREADPOOL_SIZE === undefined
      ? {}
      : { UV_THREADPOOL_SIZE: TRIED.UV_THREADPOOL_SIZE }),
  });
  baseUrl = `http://127.0.0.1:${String(port)}`;
  await api.waitUntilReady(baseUrl);
  const version = await admin.query<{ version: string }>('select version()');
  report.postgres = version.rows[0]?.version ?? '';
  report.environment = environmentRecord();
  report.settings = {
    hashAdmissionSlots: config.hashAdmission.slots,
    hashAdmissionMemoryBudgetMiB: config.hashAdmission.memoryBudgetMiB,
    argon2: config.credentialHashing.profile,
    httpAdmissionConcurrency: config.http.admissionConcurrency,
    databasePoolMax: 10,
    threadpoolSize: Number(TRIED.UV_THREADPOOL_SIZE ?? 4),
  };
}, 300_000);

afterAll(async () => {
  if (!ENABLED) return;
  // A beforeAll that failed part-way leaves some of these unset: each is closed if it exists, in spite of the others, the database last.
  await closeAll([
    () => killAll(),
    () => {
      if (OUTPUT !== undefined) writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
      return undefined;
    },
    () => (admin as ReturnType<typeof clientFor> | undefined)?.end(),
    () => (database as TestDatabase | undefined)?.drop(),
  ]);
});

/** What one request was answered: whether it is the answer the operation exists to give, and how it is told apart in the tally. */
interface Answered {
  readonly ok: boolean;
  readonly answer: string;
}

/**
 * A stage: how it was answered, in the status and code of each answer, and, when some were the answer the operation gives, their
 * latencies and the throughput. A stage in which none was is kept as it is, with its answers: a refusal is a result of the measurement.
 */
type Measured = (
  StageResult | { readonly concurrency: number; readonly runs: 0; readonly refused: number }
) & {
  readonly answers: Record<string, number>;
};

/** Runs `work` for each index from 0 to `count`, `concurrency` at a time. */
async function stage(
  concurrency: number,
  count: number,
  work: (index: number) => Promise<Answered>,
): Promise<Measured> {
  const durations: number[] = [];
  const answers: Record<string, number> = {};
  let refused = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let index = next++; index < count; index = next++) {
        const at = performance.now();
        const done = await work(index);
        answers[done.answer] = (answers[done.answer] ?? 0) + 1;
        if (done.ok) durations.push(performance.now() - at);
        else refused += 1;
      }
    }),
  );
  const elapsed = performance.now() - started;
  return durations.length === 0
    ? { concurrency, runs: 0, refused, answers }
    : { ...stageResult(concurrency, durations, elapsed, refused), answers };
}

const codeOf = (text: string): string => {
  try {
    return (JSON.parse(text) as { code?: string }).code ?? '';
  } catch {
    return '';
  }
};

const told = (response: Response, text: string): string => {
  const code = codeOf(text);
  return `${String(response.status)}${code === '' ? '' : ` ${code}`}`;
};

const signInOnce = async (email: string): Promise<Answered & { readonly cookie?: string }> => {
  const response = await fetch(`${baseUrl}${API}/auth/staff/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: OPS_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const answer = told(response, await response.text());
  const cookies = response.headers.getSetCookie().map((line) => line.split(';')[0] ?? '');
  return response.status === 200
    ? { ok: true, answer, cookie: cookies.join('; ') }
    : { ok: false, answer };
};

describe.skipIf(!ENABLED)('the integrated capacity measurement (S0.65)', () => {
  it('measures the staff sign-in at rising concurrency', async () => {
    let used = 0;
    const stages: Measured[] = [];
    for (const level of SIGN_IN_STAGES) {
      const count = Math.max(30, level * 3);
      const first = used;
      used += count;
      stages.push(
        await stage(level, count, (index) => signInOnce(staffEmails[first + index] ?? '')),
      );
    }
    report.signIn = stages;
    report.signInSaturation =
      saturation(
        stages.filter(
          (each): each is StageResult & { answers: Record<string, number> } => each.runs > 0,
        ),
      )?.concurrency ?? null;
    expect(stages.every((result) => result.runs + result.refused > 0)).toBe(true);
  }, 600_000);

  it('measures an authenticated read and a refusal at the guard at rising concurrency', async () => {
    // The general authenticated bucket is 120 a minute for each session (`rate_limit_authenticated_api`), so the reads are spread over
    // enough sessions to stay inside it: what is measured is the path, and the bucket is the next stage's subject.
    const readers: string[] = [];
    for (let index = 0; index < READERS; index += 1) {
      const signedIn = await signInOnce(staffEmails[staffEmails.length - 1 - index] ?? '');
      if (!signedIn.ok || signedIn.cookie === undefined)
        throw new Error('a reader could not sign in');
      readers.push(signedIn.cookie);
    }
    const read = async (index: number): Promise<Answered> => {
      const response = await fetch(`${baseUrl}${API}/auth/session`, {
        headers: { cookie: readers[index % readers.length] ?? '' },
      });
      const answer = told(response, await response.text());
      return { ok: response.status === 200, answer };
    };
    const refusal = async (): Promise<Answered> => {
      const response = await fetch(`${baseUrl}${API}/auth/session`);
      const answer = told(response, await response.text());
      return { ok: response.status === 401, answer };
    };
    report.read = [];
    report.refusedAtTheGuard = [];
    for (const level of READ_STAGES) report.read.push(await stage(level, READ_REQUESTS, read));
    for (const level of READ_STAGES) {
      report.refusedAtTheGuard.push(await stage(level, READ_REQUESTS, refusal));
    }
    // What the API itself said about the requests it failed, by the name of the failure: the cause of the refusals, not an inference.
    const failures: Record<string, number> = {};
    for (const line of api.stdout.split(/\r?\n/)) {
      if (!line.includes('request failed')) continue;
      try {
        const entry = JSON.parse(line) as {
          msg?: string;
          err?: { type?: string; name?: string; message?: string };
        };
        const name = `${entry.err?.type ?? entry.err?.name ?? 'unknown'}: ${(entry.err?.message ?? '').slice(0, 80)}`;
        failures[name] = (failures[name] ?? 0) + 1;
      } catch {
        failures['(a line that is not JSON)'] = (failures['(a line that is not JSON)'] ?? 0) + 1;
      }
    }
    report.apiFailures = failures;
    expect(report.read.length).toBe(READ_STAGES.length);
  }, 300_000);

  // The bucket itself: one session asked past its 120 a minute is told so at once, which a client must be able to ride out.
  it('measures what one session is told past the general authenticated limit', async () => {
    const signedIn = await signInOnce(staffEmails[0] ?? '');
    if (!signedIn.ok || signedIn.cookie === undefined)
      throw new Error('the session could not be made');
    const cookie = signedIn.cookie;
    const answers: Record<string, number> = {};
    const timings: number[] = [];
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const at = performance.now();
      const response = await fetch(`${baseUrl}${API}/auth/session`, { headers: { cookie } });
      const answer = told(response, await response.text());
      timings.push(performance.now() - at);
      answers[answer] = (answers[answer] ?? 0) + 1;
    }
    timings.sort((a, b) => a - b);
    report.oneSessionPastTheLimit = {
      requests: 160,
      answers,
      medianMs: Math.round((timings[80] ?? 0) * 10) / 10,
    };
    expect(Object.keys(answers).length).toBeGreaterThan(0);
  }, 120_000);

  it('measures the size of the session answer as the number of hubs rises, for a session of the all-hub scope', async () => {
    const finance = await insertStaff(
      admin,
      staffRow({
        roleBundleId: BUNDLE_IDS.finance,
        credentialHash:
          (
            await admin.query<{ credential_hash: string }>(
              'select credential_hash from staff_identity where work_email = $1',
              [staffEmails[0]],
            )
          ).rows[0]?.credential_hash ?? null,
        credentialGeneration: 1,
      }),
    );
    const signedIn = await signInOnce(finance.workEmail);
    if (!signedIn.ok || signedIn.cookie === undefined)
      throw new Error('the all-hub reader could not sign in');
    const cookie = signedIn.cookie;
    const rows: Report['sessionAnswerByHubs'] = [];
    let have = Number(
      (await admin.query<{ n: string }>('select count(*) as n from hub')).rows[0]?.n ?? 0,
    );
    for (const target of HUB_COUNTS) {
      while (have < target) {
        await admin.query('insert into hub (id, name) values ($1, $2)', [
          randomUUID(),
          `Benchmark hub ${String(have)}`,
        ]);
        have += 1;
      }
      const timings: number[] = [];
      let bytes = 0;
      for (let attempt = 0; attempt < 21; attempt += 1) {
        const at = performance.now();
        const response = await fetch(`${baseUrl}${API}/auth/session`, { headers: { cookie } });
        const text = await response.text();
        expect(response.status).toBe(200);
        timings.push(performance.now() - at);
        bytes = Buffer.byteLength(text);
      }
      timings.sort((a, b) => a - b);
      rows.push({ hubs: have, bytes, medianMs: Math.round((timings[10] ?? 0) * 10) / 10 });
    }
    report.sessionAnswerByHubs = rows;
    expect(rows.at(-1)?.hubs).toBeGreaterThanOrEqual(1000);
  }, 300_000);

  it('says what the figures mean for people who share one address', () => {
    const capacity =
      report.signIn?.reduce(
        (best, result) =>
          'throughputPerSecond' in result ? Math.max(best, result.throughputPerSecond) : best,
        0,
      ) ?? 0;
    // The owner's figures are inputs, not defaults: these are examples of the question, not answers to it.
    report.sharedAddress = [
      { people: 20, windowMinutes: 5 },
      { people: 100, windowMinutes: 5 },
      { people: 300, windowMinutes: 10 },
    ].map((shared) => ({ ...shared, ...sharedAddressNeed(shared, capacity) }));
    expect(capacity).toBeGreaterThan(0);
  });
});
