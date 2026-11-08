/**
 * The local gate, and the cheap check that decides whether one is worth starting (DEVELOPMENT.md, "The development loop and the gate").
 *
 * A check that takes an hour and is lost at minute ten for a reason a one-minute check would have found, or is made void by an edit made
 * while it ran, costs the hour twice. This script holds the order and the conditions that avoid that, so that nobody has to remember them.
 *
 *   node scripts/gate.ts precheck [--uncached]
 *       The cheap checks of CI (migration journal, the migration files main has, generated client, format, types, build, contract, lint) in parallel lanes, with the tool
 *       caches on: prettier and ESLint cache by content below node_modules/.cache/melarc-precheck, and turbo's task cache is used. Warm it
 *       takes seconds when little changed, and cold a few minutes. **ESLint's cache is the one place it can say less than the gate**: a file
 *       it has already read is not read again, so a type changed elsewhere can hide a finding until the gate's uncached lint. Run it after
 *       every change to a contract, a migration, a schema or a document, and before any gate. `--uncached` runs the real commands. It will
 *       not run while a gate runs: it would starve the gate and rebuild what the gate's stages read.
 *
 *   node scripts/gate.ts run [--name <name>] [--profile local|ci] [--allow-low-memory]
 *       The gate: every command CI runs that this machine can run (all but the HTTPS run, which only Linux CI makes), **once, uncached,
 *       one at a time**, on a tree that nobody edits. The cheap checks come first and all run; if any of them fails the tests do not start,
 *       because what they would say is about a tree that is not consistent. The tests all run whatever one of them did, so that one run
 *       shows everything that is wrong. It takes a fingerprint of every file Git tracks or sees as new and not ignored, watches it, and ends
 *       the run as UNSETTLED when a file changes (an edit made mid-run voids the result; a file a test makes and removes is not an edit).
 *       It will not start while the local database does not answer (`pnpm run infra:check`, read-only): the db and e2e stages need it and are
 *       reached half an hour in, and starting the database is the developer's. The local profile is the lower-concurrency one of `pnpm run
 *       test:local` (DEVELOPMENT.md). Each stage writes its own log, the lowest
 *       free memory seen while it ran is recorded (a stage that dies at process start under memory pressure says so), and the test
 *       databases that were left behind are listed (they are never dropped here). `NO_COLOR` is set, so a log is plain text but for a tool
 *       that ignores it (the Vite build's timing line).
 *
 *   node scripts/gate.ts status [--wait <seconds>]     where the latest gate is; with --wait, until its next stage ends (at most 540 s)
 *   node scripts/gate.ts stop                          stops the gate this script started, the stage it is running and itself, nothing else
 *
 *   exit 0  everything passed (and, for a gate, the tree stayed the same)
 *   exit 1  a check failed
 *   exit 2  it would not start (a gate already runs, too little free memory, the database does not answer, not a Git checkout, a bad option)
 *   exit 3  the tree changed while the gate ran: its result is void, whatever the stages said
 *   exit 130  the gate was stopped
 *
 * It starts commands from a fixed list and passes no user input to a shell. It changes nothing in the repository: logs and state are written
 * below the operating system's temporary folder, the caches below node_modules. It never drops a database, never kills a process it did not
 * start, and parses no test output: the verdict of a stage is the exit status of its command, and its numbers are read from its log.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  GATE_STAGE_TARGETS,
  affectedBase,
  recordTargets,
  runningAffected,
  type RunningAffected,
  type TargetName,
} from './affected-baselines.ts';
import { checkJdk, runProgram, type JdkCheck } from './jdk.ts';

export type Profile = 'local' | 'ci';
export type StageKind = 'static' | 'test';

export interface Stage {
  readonly name: string;
  readonly kind: StageKind;
  /** The command line, exactly as it is run and as the summary shows it. */
  readonly command: string;
  /** A stage that must have passed for this one to mean anything (the contract check reads the build). */
  readonly needs?: string;
}

/** Where `precheck` keeps the caches of prettier and ESLint: below `node_modules`, which Git ignores and nothing ships. */
export const PRECHECK_CACHE = 'node_modules/.cache/melarc-precheck';

const CACHE_FLAGS = (tool: string): string =>
  `--cache --cache-strategy content --cache-location ${PRECHECK_CACHE}/${tool}`;

interface Check {
  readonly name: string;
  readonly command: string;
  /** Added to the command by `precheck` only. */
  readonly cache?: string;
  readonly needs?: string;
  /** The lane of `precheck` it runs in: lanes run in parallel, the checks of one lane in order. */
  readonly lane: string;
}

/** Cheapest first. These are the commands of CI, word for word: the gate and the precheck add nothing to what they prove. */
const CHECKS: readonly Check[] = [
  { name: 'dbcheck', command: 'pnpm --filter @melarc/api run db:check', lane: 'dbcheck' },
  // A migration that main has is never changed (task A3.3 of the audit follow-up): the guard holds the working tree to the merge base with main.
  { name: 'migrations', command: 'node scripts/migration-immutability.ts', lane: 'dbcheck' },
  { name: 'client', command: 'pnpm run api-client:check', lane: 'client' },
  {
    name: 'format',
    command: 'pnpm run format:check',
    cache: CACHE_FLAGS('prettier'),
    lane: 'format',
  },
  { name: 'typecheck', command: 'pnpm run typecheck', lane: 'build' },
  { name: 'build', command: 'pnpm run build', lane: 'build' },
  { name: 'contract', command: 'pnpm run contract:check', needs: 'build', lane: 'build' },
  { name: 'lint', command: 'pnpm run lint', cache: CACHE_FLAGS('eslint'), lane: 'lint' },
];

/** The dependency audit: a test stage of the gate, and a lane of the precheck, since it takes seconds (the owner's decision of 27 October 2026). */
const AUDIT = 'pnpm audit --audit-level high';

/**
 * What CI runs that this script does not, and why: the HTTPS run makes a certificate authority and refuses to run on a developer machine, and the
 * plan of the run (task CI.2) asks GitHub whether the nightly run has anything to test, which only a run of the workflow has to decide.
 */
export const CI_ONLY_COMMANDS: readonly string[] = [
  'pnpm run test:e2e:https',
  'node scripts/ci-plan.ts',
];

/** The stages of the gate, in order: every cheap check, then the tests. The unit stage is the profile's. */
export function gateStages(profile: Profile): Stage[] {
  return [
    ...CHECKS.map((check): Stage => {
      const stage = { name: check.name, kind: 'static', command: check.command } as const;
      return check.needs === undefined ? stage : { ...stage, needs: check.needs };
    }),
    {
      name: 'unit',
      kind: 'test',
      command: profile === 'local' ? 'pnpm run test:local --continue' : 'pnpm run test',
    },
    { name: 'verifier', kind: 'test', command: 'pnpm run verifier:test' },
    { name: 'db', kind: 'test', command: 'pnpm run test:db' },
    { name: 'browser', kind: 'test', command: 'pnpm run test:browser' },
    { name: 'e2e', kind: 'test', command: 'pnpm run test:e2e' },
    { name: 'audit', kind: 'test', command: AUDIT },
  ];
}

/** The lanes of `precheck`, with the caches on unless `uncached`. */
export function precheckLanes(uncached: boolean): Stage[][] {
  const lanes = new Map<string, Stage[]>();
  for (const check of CHECKS) {
    const command =
      uncached || check.cache === undefined ? check.command : `${check.command} ${check.cache}`;
    const stage: Stage = {
      name: check.name,
      kind: 'static',
      command,
      ...(check.needs === undefined ? {} : { needs: check.needs }),
    };
    lanes.set(check.lane, [...(lanes.get(check.lane) ?? []), stage]);
  }
  lanes.set('audit', [{ name: 'audit', kind: 'static', command: AUDIT }]);
  return [...lanes.values()];
}

/** The environment of every command: plain text logs, and turbo's cache forced off (the gate) or left to turbo (the precheck). */
export function childEnvironment(base: NodeJS.ProcessEnv, uncached: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  if (uncached) env.TURBO_FORCE = 'true';
  else delete env.TURBO_FORCE;
  return env;
}

/**
 * The gate's environment: the uncached one, without `VITEST_MAX_WORKERS`. Every Vitest configuration bounds its own workers
 * (`MELARC_TEST_WORKERS`, 4 when unset: at Vitest's default this 16 GB workstation ran out of memory and lost tests that pass alone),
 * and Vitest applies `VITEST_MAX_WORKERS` to every project after its configuration, which would run the API's one-at-a-time projects
 * several at a time (the API's configuration refuses it). Nor does it pass `MELARC_BROWSER_SHARD`, with which the Ops Portal's
 * configuration runs one shard of its browser tests (each job of CI runs one): a gate runs the whole of every stage. The same for
 * `MELARC_DB_SHARD` (one shard of the database tests) and `MELARC_SKIP_TIMING_TESTS` (the job of a pull request leaves out the tests
 * whose bounds are wall-clock time): a gate runs every file, those included (task CI.2).
 */
export function gateEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = childEnvironment(base, true);
  delete env.VITEST_MAX_WORKERS;
  delete env.MELARC_BROWSER_SHARD;
  delete env.MELARC_DB_SHARD;
  delete env.MELARC_SKIP_TIMING_TESTS;
  return env;
}

/**
 * The gate is the owner's run (DEVELOPMENT.md, the development loop, step 5): an agent starts it only when the owner asked for it in
 * the task, and says so with `--asked`. Claude Code sets `CLAUDECODE` in the shell of every agent and in no terminal of the owner's.
 */
export function agentRefusal(env: NodeJS.ProcessEnv, asked: boolean): string | undefined {
  if (asked || env.CLAUDECODE === undefined || env.CLAUDECODE === '') return undefined;
  return "An agent is starting the gate. The gate is the owner's run (DEVELOPMENT.md, the development loop, step 5): start it only when the owner asked for it in this task, with --asked. While developing, run pnpm run test:affected.";
}

/**
 * The test targets of `pnpm run test:affected` that the passed test stages of a gate prove: what a stage runs whole and passed, on a tree
 * that stayed the same, needs no rerun until something it can reach changes. A gate whose tree changed proves nothing.
 */
export function provenTargets(state: GateState): TargetName[] {
  if (state.unsettled !== null) return [];
  return state.stages
    .filter((stage) => stage.kind === 'test' && stage.status === 'passed')
    .flatMap((stage) => GATE_STAGE_TARGETS[stage.name] ?? []);
}

/** Records the targets a gate proved, as passed on the tree it held still (scripts/affected-baselines.ts). */
export function recordProvenTargets(
  root: string,
  state: GateState,
  held: TreeSnapshot,
): TargetName[] {
  const proven = provenTargets(state);
  recordTargets(
    root,
    proven,
    new Map([...held].map(([path, file]) => [path, file.hash])),
    `gate ${state.name}`,
  );
  return proven;
}

// ------------------------------------------------------------------------------------------------ the tree

interface FileState {
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash: string;
}
export type TreeSnapshot = ReadonlyMap<string, FileState>;

const hashOf = (absolute: string): string =>
  createHash('sha256').update(readFileSync(absolute)).digest('hex');

/** The files the gate holds still: every file Git tracks or sees as new and not ignored, that is there. */
export function treeFiles(root: string): string[] {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (listed.status !== 0) {
    throw new Error(
      `Git could not list the files of the working tree (${listed.error?.message ?? `exit ${String(listed.status)}`}): the gate needs a Git checkout.`,
    );
  }
  const paths = listed.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '');
  return [...new Set(paths)].filter((path) => existsSync(join(root, path)));
}

function stateOf(root: string, path: string): FileState | undefined {
  const absolute = join(root, path);
  try {
    const stats = statSync(absolute);
    if (!stats.isFile()) return undefined;
    return { size: stats.size, mtimeMs: stats.mtimeMs, hash: hashOf(absolute) };
  } catch {
    // The file went between the listing and the read: it is not part of the tree any more.
    return undefined;
  }
}

export function snapshotTree(
  root: string,
  files: readonly string[] = treeFiles(root),
): TreeSnapshot {
  const snapshot = new Map<string, FileState>();
  for (const path of files) {
    const state = stateOf(root, path);
    if (state !== undefined) snapshot.set(path, state);
  }
  return snapshot;
}

/** One digest of the content of the whole tree, to show in the summary: the same tree gives the same digest. */
export function digestOf(snapshot: TreeSnapshot): string {
  const hash = createHash('sha256');
  for (const path of [...snapshot.keys()].toSorted()) {
    hash.update(`${path}\0${snapshot.get(path)?.hash ?? ''}\n`);
  }
  return hash.digest('hex');
}

/** Whether a file of the baseline is gone or has other content now; the same size and time is taken as unchanged and not read. */
function differs(root: string, path: string, known: FileState): boolean {
  let stats;
  try {
    stats = statSync(join(root, path));
  } catch {
    return true;
  }
  if (!stats.isFile()) return true;
  if (stats.size === known.size && stats.mtimeMs === known.mtimeMs) return false;
  return stateOf(root, path)?.hash !== known.hash;
}

/**
 * The files that were in the tree at the start and are gone or have other content: a stat for each, no listing. This is what is watched
 * while a stage runs, and it ignores new files on purpose: a test may make a file and remove it again, and that is not an edit.
 */
export function baselineChanges(root: string, before: TreeSnapshot): string[] {
  const changed: string[] = [];
  for (const [path, known] of before) if (differs(root, path, known)) changed.push(path);
  return changed.toSorted();
}

/** Everything that differs from the baseline, new files included: what is asked of the tree between two stages. */
export function changesSince(root: string, before: TreeSnapshot): string[] {
  const changed = new Set(baselineChanges(root, before));
  for (const path of treeFiles(root)) if (!before.has(path)) changed.add(path);
  return [...changed].toSorted();
}

// ------------------------------------------------------------------------------------------------ processes

/** Ends a process and everything it started. The process must be one this script started. */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    // The stage was started as the leader of a group of its own.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

interface StageOutcome {
  readonly exitCode: number | null;
  readonly spawnError: string | null;
  readonly lowestFreeMb: number;
}

interface StageRun {
  readonly pid: number | undefined;
  readonly result: Promise<StageOutcome>;
}

interface StartOptions {
  readonly stage: Stage;
  readonly log: string;
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly freeMb: () => number;
  readonly sampleMs: number;
}

/** Starts a stage: its command in a shell, its output into its log, and a sample of the free memory while it runs. */
function startStage(options: StartOptions): StageRun {
  writeFileSync(options.log, `$ ${options.stage.command}\n\n`);
  const descriptor = openSync(options.log, 'a');
  let lowest = options.freeMb();
  const sampler = setInterval(() => {
    lowest = Math.min(lowest, options.freeMb());
  }, options.sampleMs);
  let child;
  try {
    child = spawn(options.stage.command, {
      shell: true,
      cwd: options.root,
      env: options.env,
      stdio: ['ignore', descriptor, descriptor],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    clearInterval(sampler);
    throw error;
  } finally {
    // The child has its own copy of the descriptor.
    closeSync(descriptor);
  }
  const result = new Promise<StageOutcome>((done) => {
    child.once('error', (error) => {
      clearInterval(sampler);
      done({ exitCode: null, spawnError: error.message, lowestFreeMb: lowest });
    });
    child.once('close', (code) => {
      clearInterval(sampler);
      done({ exitCode: code, spawnError: null, lowestFreeMb: Math.min(lowest, options.freeMb()) });
    });
  });
  return { pid: child.pid, result };
}

// ------------------------------------------------------------------------------------------------ the record

export type StageStatus =
  'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'not-run' | 'interrupted';
export type Verdict = 'PASSED' | 'FAILED' | 'UNSETTLED' | 'INTERRUPTED';

export interface StageRecord {
  name: string;
  kind: StageKind;
  command: string;
  status: StageStatus;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  lowestFreeMb: number | null;
  log: string;
  note: string | null;
}

export interface GateState {
  name: string;
  dir: string;
  runnerPid: number;
  profile: Profile;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  verdict: Verdict | null;
  current: string | null;
  childPid: number | null;
  freeMbAtStart: number;
  lowestFreeMb: number;
  lowestFreeDuring: string | null;
  filesInTree: number;
  treeDigest: string;
  unsettled: { during: string; paths: string[] } | null;
  orphansBefore: string[] | null;
  orphansAfter: string[] | null;
  warnings: string[];
  stages: StageRecord[];
}

const STATE_FILE = 'state.json';
const POINTER_FILE = 'current.json';
const STOP_FILE = 'stop-requested';
const SUMMARY_FILE = 'summary.txt';
const DONE: readonly StageStatus[] = ['passed', 'failed', 'skipped', 'not-run', 'interrupted'];

export const gateBase = (): string => join(tmpdir(), 'melarc-gate');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function readState(dir: string): GateState | undefined {
  // The runner rewrites the file while this reads it: a half-written file is read again, once.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return readJson(join(dir, STATE_FILE)) as GateState;
    } catch {
      if (!existsSync(join(dir, STATE_FILE))) return undefined;
    }
  }
  return undefined;
}

/** The directory of the latest gate this machine started, or undefined when none was. */
export function latestGate(base: string): string | undefined {
  try {
    const pointer = readJson(join(base, POINTER_FILE)) as { dir?: unknown };
    return typeof pointer.dir === 'string' && existsSync(pointer.dir) ? pointer.dir : undefined;
  } catch {
    return undefined;
  }
}

const HEARTBEAT_STALE_MS = 30_000;

/** Whether the runner of a state is still working on it: its process is there and it said so lately. */
export function isRunning(state: GateState, now = Date.now()): boolean {
  return (
    state.verdict === null &&
    isAlive(state.runnerPid) &&
    now - Date.parse(state.updatedAt) < HEARTBEAT_STALE_MS
  );
}

/** The gate of this machine that is running now, or undefined when none is. */
export function runningGate(base: string, now = Date.now()): GateState | undefined {
  const dir = latestGate(base);
  const state = dir === undefined ? undefined : readState(dir);
  return state !== undefined && isRunning(state, now) ? state : undefined;
}

// ------------------------------------------------------------------------------------------------ rendering

const clockOf = (ms: number | null): string =>
  ms === null
    ? '-'
    : `${String(Math.floor(ms / 60_000))}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
const gigabytes = (mb: number | null): string =>
  mb === null ? '-' : `${(mb / 1024).toFixed(1)} GB`;
const localTime = (iso: string | null): string =>
  iso === null ? '-' : new Date(iso).toLocaleString('sv-SE');

export function renderSummary(state: GateState, now = Date.now()): string {
  const lines: string[] = [];
  const ended = state.endedAt === null ? now : Date.parse(state.endedAt);
  lines.push(
    `Gate ${state.name}: ${state.verdict ?? 'RUNNING'}`,
    `  ${state.profile} profile, started ${localTime(state.startedAt)}, ${clockOf(ended - Date.parse(state.startedAt))} (minutes:seconds)${state.endedAt === null ? ' so far' : ''}`,
    `  tree: ${String(state.filesInTree)} files, digest ${state.treeDigest.slice(0, 12)}${state.unsettled === null ? ', unchanged while the gate ran' : ''}`,
    `  memory: ${gigabytes(state.freeMbAtStart)} free at the start, lowest ${gigabytes(state.lowestFreeMb)}${state.lowestFreeDuring === null ? '' : ` (during ${state.lowestFreeDuring})`}`,
    '',
  );
  const width = Math.max(...state.stages.map((stage) => stage.name.length), 5);
  lines.push(
    `  ${'stage'.padEnd(width)}  ${'result'.padEnd(11)} ${'time'.padStart(6)}  ${'lowest free'.padEnd(11)}  command`,
  );
  for (const stage of state.stages) {
    lines.push(
      `  ${stage.name.padEnd(width)}  ${stage.status.padEnd(11)} ${clockOf(stage.durationMs).padStart(6)}  ${gigabytes(stage.lowestFreeMb).padEnd(11)}  ${stage.command}${stage.note === null ? '' : `   [${stage.note}]`}`,
    );
  }
  lines.push('');
  if (state.unsettled !== null) {
    lines.push(
      `The tree changed during ${state.unsettled.during}, so this run proves nothing about any tree: ${state.unsettled.paths.slice(0, 12).join(', ')}${state.unsettled.paths.length > 12 ? `, and ${String(state.unsettled.paths.length - 12)} more` : ''}.`,
      'An edit made while a gate runs voids it; so does a file a stage itself writes into the tree (a finding, then). Settle the tree and run the gate again.',
    );
  }
  const left = (state.orphansAfter ?? []).filter(
    (name) => !(state.orphansBefore ?? []).includes(name),
  );
  if (state.verdict === null) {
    // The databases are listed again when the gate ends: until then there is nothing that could not be listed.
    lines.push(
      state.orphansBefore === null
        ? 'Test databases: not listed at the start (build the API and start the database); listed again when the gate ends.'
        : `Test databases at the start: ${state.orphansBefore.length === 0 ? 'none' : state.orphansBefore.join(', ')}; listed again when the gate ends.`,
    );
  } else {
    lines.push(
      state.orphansAfter === null
        ? 'Test databases left behind: could not be listed (build the API and start the database).'
        : `Test databases left behind: ${state.orphansAfter.length === 0 ? 'none' : state.orphansAfter.join(', ')}${left.length > 0 ? `; new since the start: ${left.join(', ')}` : ''}. They are never dropped here: pnpm --filter @melarc/api run db:orphans lists them, and the developer drops them.`,
    );
  }
  for (const warning of state.warnings) lines.push(`Warning: ${warning}`);
  lines.push(`Logs: ${state.dir}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ the gate

export interface GateOptions {
  readonly root: string;
  readonly base: string;
  readonly name: string;
  readonly profile: Profile;
  readonly stages: readonly Stage[];
  readonly env: NodeJS.ProcessEnv;
  readonly allowLowMemory: boolean;
  readonly freeMb: () => number;
  /** The test databases that exist now, or null when they cannot be listed. */
  readonly listOrphans: () => string[] | null;
  /** What must hold before an hour is spent, as the problems that stop the gate from starting; none when it can start. */
  readonly preflight?: () => readonly string[];
  /** Records what the gate proved for the affected run, once it has ended; returns the targets it recorded. */
  readonly recordProven?: (state: GateState, held: TreeSnapshot) => readonly string[];
  readonly intervals: {
    readonly watchMs: number;
    readonly stopMs: number;
    readonly heartbeatMs: number;
    readonly sampleMs: number;
  };
  readonly handleSignals: boolean;
  readonly log: (line: string) => void;
}

export type GateRun =
  | { readonly kind: 'refused'; readonly problems: readonly string[] }
  | { readonly kind: 'finished'; readonly state: GateState };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
export const MEMORY_REFUSE_MB = 2048;
export const MEMORY_WARN_MB = 4096;

const nowIso = (): string => new Date().toISOString();

export async function runGate(options: GateOptions): Promise<GateRun> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const dir = join(options.base, options.name);
  if (!NAME.test(options.name)) problems.push(`"${options.name}" is not a name for a gate.`);
  else if (existsSync(dir)) problems.push(`A gate named ${options.name} already exists: ${dir}`);
  const running = runningGate(options.base);
  if (running !== undefined) {
    problems.push(
      `A gate is running (${running.name}, process ${String(running.runnerPid)}): pnpm run gate:status shows it and pnpm run gate:stop stops it. Two gates on one machine would each fail for the other's load.`,
    );
  }
  const freeAtStart = options.freeMb();
  if (freeAtStart < MEMORY_REFUSE_MB && !options.allowLowMemory) {
    problems.push(
      `Only ${gigabytes(freeAtStart)} of memory is free. A gate that runs this short of memory fails for the machine and not for the code (a stage dies at process start), and says nothing about either. Close what is not needed, or accept that with --allow-low-memory.`,
    );
  } else if (freeAtStart < MEMORY_WARN_MB) {
    warnings.push(
      `Only ${gigabytes(freeAtStart)} of memory was free at the start: a failure that looks like a process that could not start, or a test that timed out, may be the machine's.`,
    );
  }
  problems.push(...(options.preflight?.() ?? []));
  let baseline: TreeSnapshot | undefined;
  try {
    baseline = snapshotTree(options.root);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0 || baseline === undefined) return { kind: 'refused', problems };

  mkdirSync(dir, { recursive: true });
  const state: GateState = {
    name: options.name,
    dir,
    runnerPid: process.pid,
    profile: options.profile,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    endedAt: null,
    verdict: null,
    current: null,
    childPid: null,
    freeMbAtStart: freeAtStart,
    lowestFreeMb: freeAtStart,
    lowestFreeDuring: null,
    filesInTree: baseline.size,
    treeDigest: digestOf(baseline),
    unsettled: null,
    orphansBefore: options.listOrphans(),
    orphansAfter: null,
    warnings,
    stages: options.stages.map((stage): StageRecord => ({
      name: stage.name,
      kind: stage.kind,
      command: stage.command,
      status: 'pending',
      exitCode: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      lowestFreeMb: null,
      log: join(dir, `${stage.name}.log`),
      note: null,
    })),
  };
  const save = (): void => {
    state.updatedAt = nowIso();
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2));
  };
  mkdirSync(options.base, { recursive: true });
  writeFileSync(join(options.base, POINTER_FILE), JSON.stringify({ dir }));
  save();
  options.log(
    `Gate ${options.name} started (${options.profile} profile, ${String(baseline.size)} files held still, ${gigabytes(freeAtStart)} of memory free).`,
  );
  options.log(`Logs and state: ${dir}`);
  options.log(
    'Do not edit the tree while it runs: an edit voids the result. Read it with `pnpm run gate:status` (add --wait 540 to wait for the next stage), stop it with `pnpm run gate:stop`.',
  );

  const held: TreeSnapshot = baseline;
  const control: {
    halted: 'unsettled' | 'interrupted' | undefined;
    childPid: number | undefined;
  } = { halted: undefined, childPid: undefined };
  const haltedBy = (): 'unsettled' | 'interrupted' | undefined => control.halted;
  const halt = (why: 'unsettled' | 'interrupted'): void => {
    control.halted ??= why;
    if (control.childPid !== undefined) killTree(control.childPid);
  };
  const watch = setInterval(() => {
    if (control.halted !== undefined || state.current === null) return;
    const changed = baselineChanges(options.root, held);
    if (changed.length > 0) {
      state.unsettled = { during: state.current, paths: changed };
      halt('unsettled');
    }
  }, options.intervals.watchMs);
  const stopWatch = setInterval(() => {
    if (existsSync(join(dir, STOP_FILE))) halt('interrupted');
  }, options.intervals.stopMs);
  const heartbeat = setInterval(save, options.intervals.heartbeatMs);
  const onSignal = (): void => {
    halt('interrupted');
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  if (options.handleSignals) for (const signal of signals) process.on(signal, onSignal);

  try {
    for (const record of state.stages) {
      const stage = options.stages.find((candidate) => candidate.name === record.name);
      if (stage === undefined) continue;
      if (haltedBy() !== undefined) {
        record.status = 'not-run';
        record.note = haltedBy() === 'unsettled' ? 'the tree changed' : 'the gate was stopped';
        continue;
      }
      const cheapFailed = state.stages.some(
        (other) =>
          other.kind === 'static' && (other.status === 'failed' || other.status === 'skipped'),
      );
      if (stage.kind === 'test' && cheapFailed) {
        record.status = 'not-run';
        record.note = 'a cheap check failed: tests of an inconsistent tree prove nothing';
        continue;
      }
      if (stage.needs !== undefined) {
        const needed = state.stages.find((other) => other.name === stage.needs);
        if (needed?.status !== 'passed') {
          record.status = 'skipped';
          record.note = `${stage.needs} did not pass`;
          continue;
        }
      }
      record.status = 'running';
      record.startedAt = nowIso();
      state.current = stage.name;
      const started = Date.now();
      const run = startStage({
        stage,
        log: record.log,
        root: options.root,
        env: options.env,
        freeMb: options.freeMb,
        sampleMs: options.intervals.sampleMs,
      });
      control.childPid = run.pid;
      state.childPid = run.pid ?? null;
      save();
      options.log(`  ${stage.name}: running (${stage.command})`);
      const outcome = await run.result;
      control.childPid = undefined;
      state.childPid = null;
      record.endedAt = nowIso();
      record.durationMs = Date.now() - started;
      record.exitCode = outcome.exitCode;
      record.lowestFreeMb = outcome.lowestFreeMb;
      if (outcome.lowestFreeMb < state.lowestFreeMb) {
        state.lowestFreeMb = outcome.lowestFreeMb;
        state.lowestFreeDuring = stage.name;
      }
      if (haltedBy() !== undefined) {
        record.status = 'interrupted';
        record.note = haltedBy() === 'unsettled' ? 'the tree changed' : 'the gate was stopped';
      } else if (outcome.spawnError !== null) {
        record.status = 'failed';
        record.note = `could not start: ${outcome.spawnError}`;
      } else if (outcome.exitCode === 0) {
        record.status = 'passed';
      } else {
        record.status = 'failed';
        record.note = `exit ${outcome.exitCode === null ? 'by a signal' : String(outcome.exitCode)}`;
      }
      state.current = null;
      if (haltedBy() === undefined) {
        const changed = changesSince(options.root, held);
        if (changed.length > 0) {
          state.unsettled = { during: stage.name, paths: changed };
          control.halted = 'unsettled';
        }
      }
      save();
      options.log(
        `  ${stage.name}: ${record.status} after ${clockOf(record.durationMs)}${record.note === null ? '' : ` (${record.note})`}`,
      );
    }
  } finally {
    clearInterval(watch);
    clearInterval(stopWatch);
    clearInterval(heartbeat);
    if (options.handleSignals) for (const signal of signals) process.off(signal, onSignal);
  }

  state.orphansAfter = options.listOrphans();
  if (haltedBy() === 'interrupted') state.verdict = 'INTERRUPTED';
  else if (haltedBy() === 'unsettled' || state.unsettled !== null) state.verdict = 'UNSETTLED';
  else if (state.stages.every((stage) => stage.status === 'passed')) state.verdict = 'PASSED';
  else state.verdict = 'FAILED';
  state.endedAt = nowIso();
  state.current = null;
  save();
  const summary = renderSummary(state);
  writeFileSync(join(dir, SUMMARY_FILE), `${summary}\n`);
  options.log('');
  options.log(summary);
  let proven: readonly string[] = [];
  try {
    proven = options.recordProven?.(state, held) ?? [];
  } catch (error) {
    // The record is a saving for the affected run, never part of the verdict: a failure to write it is said and changes nothing else.
    options.log(
      `The tests this gate proved could not be recorded for pnpm run test:affected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (proven.length > 0) {
    options.log(
      `Recorded for pnpm run test:affected as passed on this tree: ${proven.join(', ')}.`,
    );
  }
  return { kind: 'finished', state };
}

export function exitCodeOf(run: GateRun): number {
  if (run.kind === 'refused') return 2;
  switch (run.state.verdict) {
    case 'PASSED':
      return 0;
    case 'UNSETTLED':
      return 3;
    case 'INTERRUPTED':
      return 130;
    default:
      return 1;
  }
}

// ------------------------------------------------------------------------------------------------ status and stop

export function describeStatus(
  base: string,
  now = Date.now(),
): { text: string; state?: GateState } {
  const dir = latestGate(base);
  const state = dir === undefined ? undefined : readState(dir);
  if (state === undefined) return { text: 'No gate has been started on this machine.' };
  const stale = state.verdict === null && !isRunning(state, now);
  const text = `${renderSummary(state, now)}${stale ? '\nThe runner of this gate is gone (the process ended, or it has not reported for 30 seconds): the record above is where it stopped.' : ''}`;
  return { text, state };
}

const progressOf = (state: GateState): number =>
  state.stages.filter((stage) => DONE.includes(stage.status)).length;

/** Waits until the latest gate ends or its next stage ends, at most `seconds` (never more than the longest a tool may block). */
export async function waitForProgress(base: string, seconds: number, pollMs = 2000): Promise<void> {
  const dir = latestGate(base);
  const first = dir === undefined ? undefined : readState(dir);
  if (dir === undefined || first === undefined) return;
  const at = progressOf(first);
  const deadline = Date.now() + Math.min(Math.max(seconds, 0), 540) * 1000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const state = readState(dir);
    if (state === undefined) return;
    if (state.verdict !== null || progressOf(state) !== at || !isRunning(state)) return;
  }
}

export interface StopOptions {
  readonly base: string;
  readonly graceMs: number;
  readonly pollMs: number;
  readonly log: (line: string) => void;
}

/** Asks the runner to stop and waits; only if it does not, ends the stage it started and the runner itself. */
export async function stopGate(options: StopOptions): Promise<number> {
  const dir = latestGate(options.base);
  const state = dir === undefined ? undefined : readState(dir);
  if (dir === undefined || state?.verdict !== null) {
    options.log('No gate is running.');
    return 0;
  }
  // A process number proves nothing by itself: a runner that was ended long ago may have had its number given to another process, and
  // this must never end that one. Only a record that is being kept up to date names a process that is the runner.
  if (!isRunning(state)) {
    options.log(
      `The runner of gate ${state.name} (process ${String(state.runnerPid)}) is already gone, or has not reported for 30 seconds and may be another process by now: nothing was ended.${state.childPid === null ? '' : ` Its last stage may still be running as process ${String(state.childPid)}: check before ending it, and end that process and what it started only.`}`,
    );
    return 0;
  }
  writeFileSync(join(dir, STOP_FILE), nowIso());
  options.log(`Stop requested for gate ${state.name}.`);
  const deadline = Date.now() + options.graceMs;
  while (Date.now() < deadline) {
    await sleep(options.pollMs);
    if (!isAlive(state.runnerPid)) break;
    if ((readState(dir)?.verdict ?? null) !== null) break;
  }
  if (isAlive(state.runnerPid) && (readState(dir)?.verdict ?? null) === null) {
    const latest = readState(dir);
    if (latest?.childPid !== null && latest?.childPid !== undefined) killTree(latest.childPid);
    killTree(state.runnerPid);
    options.log('The runner did not stop in time: its stage and itself were ended.');
  } else {
    options.log('The gate stopped.');
  }
  rmSync(join(dir, STOP_FILE), { force: true });
  return 0;
}

// ------------------------------------------------------------------------------------------------ the precheck

export interface PrecheckOptions {
  readonly root: string;
  readonly dir: string;
  readonly uncached: boolean;
  /** The checks, as lanes: the lanes run at the same time, the checks of one lane one after the other. */
  readonly lanes: readonly (readonly Stage[])[];
  readonly env: NodeJS.ProcessEnv;
  readonly freeMb: () => number;
  readonly log: (...lines: string[]) => void;
  readonly tailLines: number;
  /** Why the precheck must not run now, or undefined when it may. */
  readonly refusal?: () => string | undefined;
}

/** A precheck builds, lints and type-checks: beside a running gate it would starve the gate and rebuild what the gate's stages read. */
export function precheckRefusal(base: string): string | undefined {
  const running = runningGate(base);
  return running === undefined
    ? undefined
    : `A gate is running (${running.name}, process ${String(running.runnerPid)}): a precheck beside it would starve it and rebuild under it. Wait for it (pnpm run gate:status) or stop it (pnpm run gate:stop).`;
}

interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly durationMs: number;
  readonly log: string;
  readonly note: string | null;
}

const tailOf = (log: string, lines: number): string =>
  readFileSync(log, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');

/** Runs the cheap checks, lanes in parallel, and says which failed and how. Exit 0 only when every one passed. */
export async function runPrecheck(options: PrecheckOptions): Promise<number> {
  const refused = options.refusal?.();
  if (refused !== undefined) {
    options.log(refused);
    return 2;
  }
  mkdirSync(options.dir, { recursive: true });
  mkdirSync(join(options.root, PRECHECK_CACHE), { recursive: true });
  const env = childEnvironment(options.env, options.uncached);
  const started = Date.now();
  const lane = async (stages: readonly Stage[]): Promise<CheckResult[]> => {
    const results: CheckResult[] = [];
    for (const stage of stages) {
      const log = join(options.dir, `${stage.name}.log`);
      const needed =
        stage.needs === undefined ? undefined : results.find((r) => r.name === stage.needs);
      if (stage.needs !== undefined && needed?.status !== 'passed') {
        writeFileSync(log, `skipped: ${stage.needs} did not pass\n`);
        results.push({
          name: stage.name,
          command: stage.command,
          status: 'skipped',
          durationMs: 0,
          log,
          note: `${stage.needs} did not pass`,
        });
        continue;
      }
      const at = Date.now();
      const outcome = await startStage({
        stage,
        log,
        root: options.root,
        env,
        freeMb: options.freeMb,
        sampleMs: 5000,
      }).result;
      const passed = outcome.spawnError === null && outcome.exitCode === 0;
      results.push({
        name: stage.name,
        command: stage.command,
        status: passed ? 'passed' : 'failed',
        durationMs: Date.now() - at,
        log,
        note:
          outcome.spawnError !== null
            ? `could not start: ${outcome.spawnError}`
            : passed
              ? null
              : `exit ${outcome.exitCode === null ? 'by a signal' : String(outcome.exitCode)}`,
      });
    }
    return results;
  };
  const all = (await Promise.all(options.lanes.map(lane))).flat();
  const order = options.lanes.flat().map((stage) => stage.name);
  all.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const width = Math.max(...all.map((result) => result.name.length));
  options.log(
    `Precheck (${options.uncached ? 'uncached' : 'with the caches on'}), ${clockOf(Date.now() - started)}:`,
  );
  for (const result of all) {
    options.log(
      `  ${result.name.padEnd(width)}  ${result.status.padEnd(7)} ${clockOf(result.durationMs).padStart(5)}  ${result.command}${result.note === null ? '' : `   [${result.note}]`}`,
    );
  }
  const failed = all.filter((result) => result.status === 'failed');
  for (const result of failed) {
    options.log(
      '',
      `--- ${result.name}: the end of ${result.log}`,
      tailOf(result.log, options.tailLines),
    );
  }
  if (!options.uncached) {
    options.log(
      '',
      'This was the cached precheck: the gate lints and formats from scratch. A finding hidden by the cache (a type changed in another file) appears there.',
    );
  }
  options.log(
    failed.length === 0 && all.every((result) => result.status === 'passed')
      ? 'Every cheap check passed.'
      : `${String(all.filter((result) => result.status !== 'passed').length)} of ${String(all.length)} cheap checks did not pass: fix them before a gate. Logs: ${options.dir}`,
  );
  return all.every((result) => result.status === 'passed') ? 0 : 1;
}

// ------------------------------------------------------------------------------------------------ the command line

interface Parsed {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
  readonly problems: readonly string[];
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--name', '--profile', '--wait']);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['--uncached', '--allow-low-memory', '--asked']);
const FLAGS_OF: Readonly<Record<string, readonly string[]>> = {
  precheck: ['--uncached'],
  run: ['--name', '--profile', '--allow-low-memory', '--asked'],
  status: ['--wait'],
  stop: [],
};

export function parseArguments(argv: readonly string[]): Parsed {
  const [command = '', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const problems: string[] = [];
  const allowed = FLAGS_OF[command];
  if (allowed === undefined)
    problems.push(`Unknown command "${command}": precheck, run, status or stop.`);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? '';
    // pnpm passes a `--` on to the script in some shells (Git Bash) and not in others (PowerShell): it means nothing here.
    if (flag === '--') continue;
    if (allowed !== undefined && !allowed.includes(flag)) {
      problems.push(`"${flag}" is not an option of ${command}.`);
    } else if (BOOLEAN_FLAGS.has(flag)) {
      flags.set(flag, true);
    } else if (VALUE_FLAGS.has(flag)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) problems.push(`${flag} needs a value.`);
      else flags.set(flag, value);
      index += 1;
    } else if (allowed !== undefined) {
      problems.push(`"${flag}" is not an option of ${command}.`);
    }
  }
  return { command, flags, problems };
}

const USAGE = [
  'Usage: node scripts/gate.ts <command>',
  '  precheck [--uncached]                                   the cheap checks, in parallel, with the caches on',
  '  run [--name <name>] [--profile local|ci] [--allow-low-memory] [--asked]   the gate: every command CI runs, once, uncached, on a settled',
  "                                                          tree; the owner's run (an agent adds --asked only when the owner asked for it)",
  '  status [--wait <seconds>]                               where the latest gate is (--wait: until its next stage ends, at most 540 s)',
  '  stop                                                    stops the gate this script started',
].join('\n');

const defaultName = (): string => {
  const at = new Date();
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
};

/** The test databases that exist, from the API's read-only listing; null when it cannot run (no build, no database). */
function listOrphans(root: string): string[] | null {
  const listed = spawnSync('pnpm --filter @melarc/api run db:orphans', {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  if (listed.status !== 0) return null;
  return [...new Set(listed.stdout.match(/melarc_test_[0-9a-f]+/g) ?? [])].toSorted();
}

/** An affected run that is running: the gate beside it would starve it, run the same browsers' ports and roles, and read its tree. */
export function affectedProblems(running: RunningAffected | undefined): string[] {
  return running === undefined
    ? []
    : [
        `An affected run is running (process ${String(running.pid)}, since ${running.startedAt}): a gate beside it would starve it and share its ports, roles and build. Let it finish, then start the gate.`,
      ];
}

/** The developer's own check that a database answers: it sends no credential and changes nothing. */
export const DATABASE_CHECK = 'pnpm run infra:check';

/**
 * The db and e2e stages need the local database, and the gate reaches them some thirty minutes in: a database that is not there is
 * found out at the start instead, with the check above. The gate never starts the database.
 */
export function databaseProblems(root: string, probe = DATABASE_CHECK): string[] {
  const probed = spawnSync(probe, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (probed.status === 0) return [];
  return [
    `The database does not answer, and the db and e2e stages need it: a gate would find that out only after the cheap checks and the unit tests. \`${DATABASE_CHECK}\` says why. The developer starts the database (\`pnpm run infra:up\`, DEVELOPMENT.md step 3); then run the gate again.`,
  ];
}

/**
 * The verifier stage builds and tests the attestation verifier, and one test of the db stage starts it: both need the JDK `.java-version`
 * pins, and the gate reaches them only after the cheap checks and the unit tests. A JDK that is missing or of another version is found
 * out at the start instead, judged as scripts/verifier.ts judges it (scripts/jdk.ts). The gate never installs or chooses one.
 */
export function jdkProblems(check: JdkCheck): string[] {
  if (check.ok) return [];
  return [
    `${check.problem} The verifier stage, and the test of the db stage that starts the verifier, need it and would fail. Set JAVA_HOME to that JDK, or put its bin folder on the path (DEVELOPMENT.md, "The attestation verifier"); then run the gate again.`,
  ];
}

const freeMegabytes = (): number => Math.round(freemem() / 1_048_576);

/** The precheck `precheck` starts: the real commands, the caches on unless `uncached`, and no precheck beside a running gate. */
export function commandLinePrecheck(
  root: string,
  uncached: boolean,
  base = gateBase(),
): PrecheckOptions {
  return {
    root,
    dir: join(base, 'precheck'),
    uncached,
    lanes: precheckLanes(uncached),
    env: process.env,
    freeMb: freeMegabytes,
    log: (...lines) => {
      for (const line of lines) console.log(line);
    },
    tailLines: 30,
    refusal: () => precheckRefusal(base),
  };
}

/** The gate `run` starts: this machine, the real commands, and every safeguard on. One place wires them, so that one test can hold them. */
export function commandLineGate(
  root: string,
  profile: Profile,
  name: string,
  allowLowMemory: boolean,
  affectedRuns: string = affectedBase(),
  databaseCheck: string = DATABASE_CHECK,
  jdk: () => JdkCheck = () => checkJdk(root, process.env, process.platform, runProgram),
): GateOptions {
  return {
    root,
    base: gateBase(),
    name,
    profile,
    stages: gateStages(profile),
    env: gateEnvironment(process.env),
    allowLowMemory,
    freeMb: freeMegabytes,
    listOrphans: () => listOrphans(root),
    preflight: () => [
      ...affectedProblems(runningAffected(affectedRuns)),
      ...databaseProblems(root, databaseCheck),
      ...jdkProblems(jdk()),
    ],
    recordProven: (state, held) => recordProvenTargets(root, state, held),
    intervals: { watchMs: 15_000, stopMs: 1000, heartbeatMs: 5000, sampleMs: 2000 },
    handleSignals: true,
    log: (line) => {
      console.log(line);
    },
  };
}

export async function main(argv: readonly string[], root: string): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.problems.length > 0) {
    for (const problem of parsed.problems) console.error(problem);
    console.error(USAGE);
    return 2;
  }
  const log = (...lines: string[]): void => {
    for (const line of lines) console.log(line);
  };
  switch (parsed.command) {
    case 'precheck':
      return runPrecheck(commandLinePrecheck(root, parsed.flags.has('--uncached')));
    case 'run': {
      const refusal = agentRefusal(process.env, parsed.flags.has('--asked'));
      if (refusal !== undefined) {
        console.error(refusal);
        return 2;
      }
      const profile = parsed.flags.get('--profile') ?? 'local';
      if (profile !== 'local' && profile !== 'ci') {
        console.error('--profile is local or ci.');
        return 2;
      }
      const name = parsed.flags.get('--name');
      const result = await runGate(
        commandLineGate(
          root,
          profile,
          typeof name === 'string' ? name : defaultName(),
          parsed.flags.has('--allow-low-memory'),
        ),
      );
      if (result.kind === 'refused') {
        for (const problem of result.problems) console.error(problem);
      }
      return exitCodeOf(result);
    }
    case 'status': {
      const wait = parsed.flags.get('--wait');
      if (typeof wait === 'string') {
        const seconds = Number(wait);
        if (!Number.isFinite(seconds) || seconds < 0) {
          console.error('--wait is a number of seconds.');
          return 2;
        }
        await waitForProgress(gateBase(), seconds);
      }
      log(describeStatus(gateBase()).text);
      return 0;
    }
    default:
      return stopGate({
        base: gateBase(),
        graceMs: 30_000,
        pollMs: 500,
        log: (line) => {
          console.log(line);
        },
      });
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dirname, '..'));
}
