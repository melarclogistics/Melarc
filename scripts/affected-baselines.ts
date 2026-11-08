/**
 * The record of the last green run of each test target of `pnpm run test:affected` (scripts/affected.ts): the content of every file of the
 * tree when the target last passed, so that the next run chooses only the tests that a change made since then can reach. A gate whose test
 * stage passed on a settled tree records the targets that stage proves (`GATE_STAGE_TARGETS`), and so does an affected run for each target
 * it ran green.
 *
 * It lives below `node_modules/.cache`, which Git ignores and nothing ships, and it is only ever a saving: a missing, unreadable or foreign
 * record makes the next run compare with the last commit instead, which chooses more tests, never fewer. It imports Node built-ins only,
 * so that the gate can write it without loading the selector.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The test targets, in the order an affected run runs them: the cheap ones first. */
export const TARGETS = [
  'root',
  'api-client',
  'e2e-unit',
  'ops-unit',
  'api-unit',
  'api-process',
  'api-db',
  'ops-browser',
  'verifier',
  'e2e',
] as const;
export type TargetName = (typeof TARGETS)[number];

export const isTarget = (name: string): name is TargetName =>
  (TARGETS as readonly string[]).includes(name);

/**
 * The targets each test stage of the gate (scripts/gate.ts) runs whole: a stage that passed on a settled tree proves them for that tree.
 * The unit stage is `pnpm run test:local --continue` (or `pnpm test`), which runs the root tests and every package's `test` script.
 */
export const GATE_STAGE_TARGETS: Readonly<Record<string, readonly TargetName[]>> = {
  unit: ['root', 'api-client', 'e2e-unit', 'ops-unit', 'api-unit', 'api-process'],
  verifier: ['verifier'],
  db: ['api-db'],
  browser: ['ops-browser'],
  e2e: ['e2e'],
};

export const BASELINE_FILE = 'node_modules/.cache/melarc-affected/baselines.json';

/** A file of the tree and the SHA-256 of its content, by its path from the repository root with forward slashes. */
export type FileHashes = ReadonlyMap<string, string>;

export interface TargetRecord {
  /** The digest of the tree the target passed on (a key of `snapshots`). */
  readonly snapshot: string;
  readonly recordedAt: string;
  /** What ran it green: `gate <name>` or `affected`. */
  readonly by: string;
}

interface Store {
  readonly version: 1;
  readonly targets: Partial<Record<TargetName, TargetRecord>>;
  readonly snapshots: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const EMPTY: Store = { version: 1, targets: {}, snapshots: {} };

/** One digest of a set of files and their contents: the same tree gives the same digest. */
export function digestOfHashes(files: FileHashes): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].toSorted())
    hash.update(`${path}\0${files.get(path) ?? ''}\n`);
  return hash.digest('hex');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The store, or an empty one when there is none or it cannot be trusted: the caller then compares with the last commit. */
export function readStore(root: string): Store {
  const path = join(root, BASELINE_FILE);
  if (!existsSync(path)) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !isRecord(parsed.targets) ||
      !isRecord(parsed.snapshots)
    ) {
      return EMPTY;
    }
    const snapshots: Record<string, Record<string, string>> = {};
    for (const [digest, files] of Object.entries(parsed.snapshots)) {
      if (!isRecord(files)) continue;
      const hashes = Object.entries(files);
      if (!hashes.every(([, hash]) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))
        continue;
      const kept = Object.fromEntries(hashes) as Record<string, string>;
      // A snapshot whose content does not give its own name was changed by hand or cut short: it is not trusted.
      if (digestOfHashes(new Map(Object.entries(kept))) !== digest) continue;
      snapshots[digest] = kept;
    }
    const targets: Partial<Record<TargetName, TargetRecord>> = {};
    for (const [name, record] of Object.entries(parsed.targets)) {
      if (!isTarget(name) || !isRecord(record)) continue;
      const { snapshot, recordedAt, by } = record;
      if (typeof snapshot !== 'string' || typeof recordedAt !== 'string' || typeof by !== 'string')
        continue;
      if (snapshots[snapshot] === undefined) continue;
      targets[name] = { snapshot, recordedAt, by };
    }
    return { version: 1, targets, snapshots };
  } catch {
    return EMPTY;
  }
}

/** The tree a target last passed on, or undefined when it has no trusted record. */
export function baselineOf(
  root: string,
  target: TargetName,
  store: Store = readStore(root),
): { readonly record: TargetRecord; readonly files: FileHashes } | undefined {
  const record = store.targets[target];
  const files = record === undefined ? undefined : store.snapshots[record.snapshot];
  return record === undefined || files === undefined
    ? undefined
    : { record, files: new Map(Object.entries(files)) };
}

/** Records that `targets` passed on the tree `files`. Snapshots that no target names any more are dropped. Written whole or not at all. */
export function recordTargets(
  root: string,
  targets: readonly TargetName[],
  files: FileHashes,
  by: string,
  now: Date = new Date(),
): void {
  if (targets.length === 0) return;
  const store = readStore(root);
  const digest = digestOfHashes(files);
  const record: TargetRecord = { snapshot: digest, recordedAt: now.toISOString(), by };
  const nextTargets: Partial<Record<TargetName, TargetRecord>> = { ...store.targets };
  for (const target of targets) nextTargets[target] = record;
  const named = new Set(Object.values(nextTargets).map((entry) => entry.snapshot));
  const snapshots: Record<string, Readonly<Record<string, string>>> = {};
  for (const name of named) {
    if (name === digest) snapshots[name] = Object.fromEntries(files);
    else {
      const kept = store.snapshots[name];
      if (kept !== undefined) snapshots[name] = kept;
    }
  }
  const path = join(root, BASELINE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, targets: nextTargets, snapshots }));
  renameSync(temporary, path);
}

/** Forgets every record: the next run compares every target with the last commit. */
export function forgetAll(root: string): void {
  rmSync(join(root, BASELINE_FILE), { force: true });
}

// ------------------------------------------------------------------------------------------------ one run at a time

/**
 * Where an affected run says that it is running, for this machine: two runs at once, or a run beside a gate, share the browsers'
 * ports, the database server's roles, the Ops Portal's build and the memory, and each would fail for the other.
 */
export const affectedBase = (): string => join(tmpdir(), 'melarc-affected');
const RUNNING_FILE = 'running.json';
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;

export interface RunningAffected {
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** The affected run of this machine that is running now, or undefined: one whose process is gone or has not reported lately is not. */
export function runningAffected(
  base: string = affectedBase(),
  now: number = Date.now(),
): RunningAffected | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(base, RUNNING_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { pid, startedAt, updatedAt } = parsed;
  if (typeof pid !== 'number' || typeof startedAt !== 'string' || typeof updatedAt !== 'string')
    return undefined;
  if (now - Date.parse(updatedAt) >= STALE_MS || !isAlive(pid)) return undefined;
  return { pid, startedAt, updatedAt };
}

/** Says that this process runs an affected run, until the function it returns is called (or the process ends and goes stale). */
export function markRunning(base: string = affectedBase()): () => void {
  mkdirSync(base, { recursive: true });
  const path = join(base, RUNNING_FILE);
  const startedAt = new Date().toISOString();
  const write = (): void => {
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, startedAt, updatedAt: new Date().toISOString() }),
    );
  };
  write();
  const heartbeat = setInterval(write, HEARTBEAT_MS);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    rmSync(path, { force: true });
  };
}
