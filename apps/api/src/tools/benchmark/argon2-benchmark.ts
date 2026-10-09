import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  ARGON2ID_SALT_BYTES,
  isValidArgon2idParameters,
  type Argon2idParameters,
} from '../../platform/auth/crypto/argon2-parameters.js';
import { argon2idTag, type Argon2idInput } from '../../platform/auth/crypto/argon2id.js';
import { CliUsageError } from '../database/cli.js';

/**
 * The single-hash benchmark of plan task S0.3a. It times one Argon2id derivation at a time, sequentially, for each cost in a
 * grid, on the machine it runs on, and records that machine. It measures nothing under load and makes no capacity claim: what a
 * local figure shows is how long one hash takes here, which is what the plan asks a first consumer to record
 * (plan §3, "Engineering parameters"). The integrated measurement and the deployment values are S0.65's.
 *
 * It hashes a fixed synthetic text with a throwaway salt and pepper, and prints none of them.
 */

/** The median single-hash time the development-qualified cost aims for: an engineering convention, not a product decision. */
export const TARGET_MEDIAN_MS = 100;

/**
 * The costs measured by default. Lanes stay at one: a hash with more lanes spreads over several cores (measured here: four lanes
 * finished in about half the time of one at the same passes), which the capacity analysis cannot treat as one pool thread.
 */
export const DEFAULT_CANDIDATES: readonly Argon2idParameters[] = Object.freeze([
  Object.freeze({ memoryKiB: 19_456, passes: 2, parallelism: 1 }),
  Object.freeze({ memoryKiB: 19_456, passes: 3, parallelism: 1 }),
  Object.freeze({ memoryKiB: 32_768, passes: 2, parallelism: 1 }),
  Object.freeze({ memoryKiB: 46_080, passes: 1, parallelism: 1 }),
  Object.freeze({ memoryKiB: 65_536, passes: 2, parallelism: 1 }),
  Object.freeze({ memoryKiB: 65_536, passes: 3, parallelism: 1 }),
  Object.freeze({ memoryKiB: 131_072, passes: 2, parallelism: 1 }),
]);

const DEFAULT_RUNS = 9;
const MIN_RUNS = 3;
const MAX_RUNS = 200;
const MAX_NOTE_LENGTH = 200;
const SYNTHETIC_INPUT = 'synthetic benchmark input, not a credential';
const STATUS = 'development-qualified, not production-qualified';

export const BENCHMARK_USAGE =
  'usage: node dist/tools/benchmark-argon2.js [--runs <3-200>] [--note <text>] [--memory-kib <n> --passes <n> --parallelism <n>]';

export interface BenchmarkOptions {
  readonly candidates: readonly Argon2idParameters[];
  readonly runs: number;
  /** What else was running, in the operator's words: a measurement is only as good as the machine's state was. */
  readonly note: string | undefined;
}

const FLAGS = ['--runs', '--note', '--memory-kib', '--passes', '--parallelism'] as const;
type Flag = (typeof FLAGS)[number];

function wholeNumber(flag: string, text: string): number {
  if (!/^\d{1,10}$/.test(text))
    throw new CliUsageError(`${flag} takes a whole number. ${BENCHMARK_USAGE}`);
  return Number(text);
}

export function parseBenchmarkArguments(argv: readonly string[]): BenchmarkOptions {
  const given = new Map<Flag, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !(FLAGS as readonly string[]).includes(flag)) {
      throw new CliUsageError(`Unknown argument. ${BENCHMARK_USAGE}`);
    }
    if (value === undefined) throw new CliUsageError(`${flag} needs a value. ${BENCHMARK_USAGE}`);
    if (given.has(flag as Flag))
      throw new CliUsageError(`${flag} was given twice. ${BENCHMARK_USAGE}`);
    given.set(flag as Flag, value);
  }

  const runsText = given.get('--runs');
  const runs = runsText === undefined ? DEFAULT_RUNS : wholeNumber('--runs', runsText);
  if (runs < MIN_RUNS || runs > MAX_RUNS) {
    throw new CliUsageError(
      `--runs is from ${String(MIN_RUNS)} to ${String(MAX_RUNS)}. ${BENCHMARK_USAGE}`,
    );
  }

  const note = given.get('--note');
  if (note !== undefined && !(note.length <= MAX_NOTE_LENGTH && /^[ -~]*$/.test(note))) {
    throw new CliUsageError(
      `--note is printable ASCII of at most ${String(MAX_NOTE_LENGTH)} characters. ${BENCHMARK_USAGE}`,
    );
  }

  const cost = (['--memory-kib', '--passes', '--parallelism'] as const).map((flag) =>
    given.get(flag),
  );
  if (cost.every((value) => value === undefined)) {
    return { candidates: DEFAULT_CANDIDATES, runs, note };
  }
  const [memory, passes, lanes] = cost;
  if (memory === undefined || passes === undefined || lanes === undefined) {
    throw new CliUsageError(
      `--memory-kib, --passes and --parallelism go together. ${BENCHMARK_USAGE}`,
    );
  }
  const single = {
    memoryKiB: wholeNumber('--memory-kib', memory),
    passes: wholeNumber('--passes', passes),
    parallelism: wholeNumber('--parallelism', lanes),
  };
  if (!isValidArgon2idParameters(single)) {
    throw new CliUsageError(
      `That cost is outside the limits: memory is at least 8 KiB and a multiple of 4 KiB per lane. ${BENCHMARK_USAGE}`,
    );
  }
  return { candidates: [single], runs, note };
}

export interface RunSummary {
  readonly runs: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

/** The minimum, median, nearest-rank 95th percentile and maximum. The input is not reordered. */
export function summarise(durationsMs: readonly number[]): RunSummary {
  if (durationsMs.length === 0) throw new RangeError('There are no runs to summarise.');
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const at = (rank: number): number => sorted[rank - 1] ?? Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? at(middle + 1) : (at(middle) + at(middle + 1)) / 2;
  return {
    runs: sorted.length,
    minMs: at(1),
    medianMs: median,
    p95Ms: at(Math.ceil(0.95 * sorted.length)),
    maxMs: at(sorted.length),
  };
}

export interface CandidateResult extends RunSummary {
  readonly parameters: Argon2idParameters;
}

/**
 * The rule that chose the development-qualified cost: of the single-lane candidates whose median reaches the target, the one
 * with the least memory (then the fewest passes). Nothing when none does.
 */
export function selectCandidate(results: readonly CandidateResult[]): CandidateResult | undefined {
  return results
    .filter((r) => r.parameters.parallelism === 1 && r.medianMs >= TARGET_MEDIAN_MS)
    .sort(
      (a, b) =>
        a.parameters.memoryKiB - b.parameters.memoryKiB ||
        a.parameters.passes - b.parameters.passes,
    )
    .at(0);
}

interface MeasureDependencies {
  readonly derive?: (input: Argon2idInput) => Promise<Uint8Array>;
  readonly now?: () => number;
}

/** One unmeasured warm-up, then `runs` timed derivations, one at a time. */
export async function measure(
  parameters: Argon2idParameters,
  runs: number,
  { derive = argon2idTag, now = () => performance.now() }: MeasureDependencies = {},
): Promise<number[]> {
  const input = (): Argon2idInput => ({
    message: Buffer.from(SYNTHETIC_INPUT, 'utf8'),
    salt: randomBytes(ARGON2ID_SALT_BYTES),
    parameters,
    pepper: randomBytes(32),
    associatedData: Buffer.from('benchmark', 'ascii'),
  });
  await derive(input());
  const durations: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const prepared = input();
    const start = now();
    await derive(prepared);
    durations.push(now() - start);
  }
  return durations;
}

export interface EnvironmentRecord {
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
  readonly cpuModel: string;
  readonly logicalCpus: number;
  readonly totalMemoryMiB: number;
  readonly node: string;
  readonly openssl: string;
  /** The libuv pool a hash runs on, shared with file system, DNS and other crypto work. */
  readonly threadpoolSize: number;
  readonly postgresql: string;
}

/** The machine and runtime. The plan also asks for the PostgreSQL version; no database takes part in a hash. */
export function environmentRecord(): EnvironmentRecord {
  const cpus = os.cpus();
  const pool = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10);
  return {
    platform: os.platform(),
    release: `${os.version()} ${os.release()}`,
    architecture: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    logicalCpus: cpus.length,
    totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
    node: process.versions.node,
    openssl: process.versions.openssl,
    threadpoolSize: Number.isInteger(pool) && pool >= 1 ? Math.min(pool, 1024) : 4,
    postgresql: 'not involved: no database is used by this measurement',
  };
}

export interface BenchmarkReport {
  readonly status: typeof STATUS;
  readonly targetMedianMs: number;
  readonly measuredAt: string;
  readonly environment: EnvironmentRecord;
  readonly note: string | undefined;
  readonly candidates: readonly CandidateResult[];
  /** The cost the rule picks, or null when no single-lane candidate reached the target. */
  readonly selected: Argon2idParameters | null;
}

interface RunDependencies extends MeasureDependencies {
  readonly environment?: () => EnvironmentRecord;
  readonly measuredAt?: () => string;
}

export async function runBenchmark(
  options: BenchmarkOptions,
  {
    environment = environmentRecord,
    measuredAt = () => new Date().toISOString(),
    ...rest
  }: RunDependencies = {},
): Promise<BenchmarkReport> {
  const candidates: CandidateResult[] = [];
  for (const parameters of options.candidates) {
    candidates.push({ parameters, ...summarise(await measure(parameters, options.runs, rest)) });
  }
  return {
    status: STATUS,
    targetMedianMs: TARGET_MEDIAN_MS,
    measuredAt: measuredAt(),
    environment: environment(),
    note: options.note,
    candidates,
    selected: selectCandidate(candidates)?.parameters ?? null,
  };
}

export function formatReport(report: BenchmarkReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
