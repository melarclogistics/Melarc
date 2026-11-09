/**
 * Fails when a migration that main already has has been changed, renamed or removed (task A3.3 of the audit follow-up, the Product Owner's decision of
 * 7 November 2026). A migration an environment may hold is never edited: its text is what the database recorded as applied, `runMigrations` refuses an
 * applied migration whose text changed, and a fix to an earlier migration's function, policy or trigger is a new migration
 * ([apps/api/CLAUDE.md](../apps/api/CLAUDE.md), "Migrations only go forward"). What an environment may hold is what main has: a migration that is only on a
 * branch has reached no environment of the team, and may still be corrected in place until the branch is merged (migration 0078 was, on the branch this guard
 * was written on).
 *
 *   node scripts/migration-immutability.ts [--base <revision>]
 *
 *   exit 0   every migration file the base holds is, in the working tree, what the base holds
 *   exit 1   one is changed, renamed or removed
 *   exit 2   it could not decide: there is no main to compare with, or no history that reaches it (a shallow clone), or the base holds no migration at all.
 *            **Outside CI that is a warning and the exit is 0** (run 4, Stage 1, item 9): a tree with no main (a source package, a clone that fetched no branch)
 *            must not stop the precheck, and says on stderr that nothing was held. **In CI (`CI=true`, which GitHub Actions sets) it stays 2**: CI checks out the whole
 *            history and has main, so there a guard that cannot tell is a failure, and it never passes by having nothing to look at.
 *
 * **The base.** `--base`, else `MELARC_MIGRATION_BASE` (what a CI job that knows better names: the revision a push to main came from; a developer may set it too, to
 * hold a tree that has no main to a revision it does have: DEVELOPMENT.md), else the merge base of
 * `HEAD` and main (`origin/main`, else a local `main`). **How it behaves while main lacks the files:** a file that main does not have is not frozen, so the
 * migrations a branch adds (and corrects) are free until they merge, and from the merge on they are frozen; on the branch of the Ops Portal redesign `0074` to `0079` are
 * free today, because origin/main (d600057, the merge of 8 November 2026) holds `0000` to `0073`. When `HEAD` is main itself the base is `HEAD`, so what the guard then catches is an uncommitted edit of a committed
 * migration. **It never passes by having nothing to look at**: no main, no shared history, or a base with no migration under
 * the folder (a moved folder, a wrong base) is exit 2 and says what to do, and never exit 0. The guard needs the full history (`git fetch --unshallow`, or
 * `fetch-depth: 0` in CI) because it asks Git for a merge base.
 *
 * What is held: every file of the folder at the base, byte for byte (what Git would store: the working copy's line endings do not count), except the journal
 * (`meta/_journal.json`), which gains an entry with every migration: each entry the base has must be in the working tree's journal exactly as it was.
 *
 * It uses only Node's own modules, so that CI can run it before any install.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The folder whose files the guard holds, from the root of the repository. */
export const MIGRATIONS_DIRECTORY = 'apps/api/migrations';
const JOURNAL = `${MIGRATIONS_DIRECTORY}/meta/_journal.json`;
const MAIN_REFS = ['refs/remotes/origin/main', 'refs/heads/main'] as const;
const ZERO_REVISION = /^0{40}$/;

/** Whether this is a CI run: GitHub Actions sets `CI=true`, and a developer's shell does not. */
export function inCi(env: NodeJS.ProcessEnv): boolean {
  return env.CI === 'true';
}

/** The guard could not decide (exit 2): what is missing, and what to do about it. */
export class MigrationImmutabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationImmutabilityError';
  }
}

export interface ImmutabilityReport {
  /** The commit compared with, in full. */
  readonly base: string;
  /** How the base was chosen, in words for the message. */
  readonly baseWas: string;
  /** How many files of the base the working tree was held to. */
  readonly held: number;
  /** How many files of the working tree are not at the base: free to change until they reach main. */
  readonly free: number;
  /** One line for each file that is not what the base holds. Empty when the guard passes. */
  readonly problems: readonly string[];
}

function git(root: string, args: readonly string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** The commit a name resolves to, or undefined: a missing name is an answer here and not an error. */
function commitOf(root: string, name: string): string | undefined {
  const run = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  const found = run.stdout.trim();
  return run.status === 0 && found !== '' ? found : undefined;
}

/** The commit the working tree is held to, and how it was chosen. */
export function baseOf(
  root: string,
  explicit: string | undefined,
): { readonly base: string; readonly baseWas: string } {
  const named = explicit?.trim();
  if (named !== undefined && named !== '' && !ZERO_REVISION.test(named)) {
    const commit = commitOf(root, named);
    if (commit === undefined) {
      throw new MigrationImmutabilityError(
        `The base revision "${named}" is not a commit this clone has. Fetch it (git fetch origin), or name another in MELARC_MIGRATION_BASE or --base.`,
      );
    }
    return { base: commit, baseWas: `the revision named (${named})` };
  }

  const ref = MAIN_REFS.find((candidate) => commitOf(root, candidate) !== undefined);
  const main = ref === undefined ? undefined : commitOf(root, ref);
  if (ref === undefined || main === undefined) {
    throw new MigrationImmutabilityError(
      'There is no main to compare the migrations with (no origin/main and no local main). Fetch it (git fetch origin main), or name a revision in MELARC_MIGRATION_BASE or --base.',
    );
  }
  const shared = spawnSync('git', ['merge-base', 'HEAD', main], { cwd: root, encoding: 'utf8' });
  const base = shared.stdout.trim();
  if (shared.status !== 0 || base === '') {
    const shallow = commitOf(root, 'HEAD') !== undefined && isShallow(root);
    throw new MigrationImmutabilityError(
      `HEAD and ${ref.replace('refs/remotes/', '').replace('refs/heads/', '')} share no history this clone holds` +
        (shallow
          ? ': it is a shallow clone (git fetch --unshallow, or fetch-depth: 0 in the CI checkout).'
          : '.'),
    );
  }
  return {
    base,
    baseWas: `the merge base of HEAD and ${ref.replace('refs/remotes/', '').replace('refs/heads/', '')}`,
  };
}

function isShallow(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    return false;
  }
}

interface HeldFile {
  readonly path: string;
  readonly blob: string;
}

/** Every file of the migrations folder at the base, with the object Git stores for it. */
function filesAt(root: string, base: string): HeldFile[] {
  const listed = git(root, ['ls-tree', '-r', '-z', base, '--', MIGRATIONS_DIRECTORY]);
  return listed
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, , blob] = line.slice(0, tab).split(' ');
      return { path: line.slice(tab + 1), blob: blob ?? '' };
    });
}

/** The objects Git would store for these working-tree files (filters applied: line endings do not count), in the order given. One process for all. */
function blobsOf(root: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const out = git(root, ['hash-object', '--stdin-paths'], `${paths.join('\n')}\n`);
  return out.split('\n').filter((line) => line !== '');
}

/** The files the working tree holds under the folder, as Git sees them: tracked and new, never ignored. */
function filesNow(root: string): string[] {
  return git(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    MIGRATIONS_DIRECTORY,
  ])
    .split('\0')
    .filter((line) => line !== '');
}

interface JournalEntry {
  readonly idx: number;
  readonly [key: string]: unknown;
}

function journalEntries(text: string): readonly JournalEntry[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const entries = (parsed as { entries?: unknown }).entries;
    return Array.isArray(entries) ? (entries as JournalEntry[]) : undefined;
  } catch {
    return undefined;
  }
}

/** The journal gains an entry with every migration, so it is held by its entries: each the base has is in the working tree's, unchanged. */
function journalProblems(root: string, base: string, current: string | undefined): string[] {
  const before = journalEntries(git(root, ['show', `${base}:${JOURNAL}`]));
  if (before === undefined) return [];
  if (current === undefined) {
    return [`${JOURNAL} is not in the working tree: the journal main has is never removed.`];
  }
  const after = journalEntries(current);
  if (after === undefined) return [`${JOURNAL} is not a journal of entries any more.`];
  const problems: string[] = [];
  for (const entry of before) {
    const now = after.find((candidate) => candidate.idx === entry.idx);
    if (now === undefined || JSON.stringify(now) !== JSON.stringify(entry)) {
      problems.push(
        `${JOURNAL}: the entry ${String(entry.idx)} (${String(entry.tag)}), which main has, is ${now === undefined ? 'gone' : 'changed'}.`,
      );
    }
  }
  return problems;
}

/** Holds the working tree of `root` to the migration files of the base. Throws `MigrationImmutabilityError` when it cannot decide. */
export function checkMigrationImmutability(options: {
  readonly root: string;
  readonly base?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): ImmutabilityReport {
  const root = resolve(options.root);
  const { base, baseWas } = baseOf(
    root,
    options.base ?? (options.env ?? process.env).MELARC_MIGRATION_BASE,
  );
  const atBase = filesAt(root, base);
  if (atBase.length === 0) {
    throw new MigrationImmutabilityError(
      `The base (${base.slice(0, 12)}, ${baseWas}) holds no file under ${MIGRATIONS_DIRECTORY}: the folder moved or the base is wrong, and a guard with nothing to hold passes nothing.`,
    );
  }

  const problems: string[] = [];
  const present = atBase.filter((file) => existsSync(join(root, file.path)));
  for (const file of atBase) {
    if (!present.includes(file) && file.path !== JOURNAL) {
      problems.push(
        `${file.path} is removed or renamed, and main has it: a migration main has is never removed (apps/api/CLAUDE.md, "Migrations only go forward").`,
      );
    }
  }
  const heldNow = present.filter((file) => file.path !== JOURNAL);
  const nowBlobs = blobsOf(
    root,
    heldNow.map((file) => file.path),
  );
  heldNow.forEach((file, index) => {
    if (nowBlobs[index] !== file.blob) {
      problems.push(
        `${file.path} is changed, and main has it: a migration main has is never edited. Put it back and add a new migration for the change (apps/api/CLAUDE.md, "Migrations only go forward").`,
      );
    }
  });
  const journal = atBase.some((file) => file.path === JOURNAL)
    ? journalProblems(
        root,
        base,
        existsSync(join(root, JOURNAL)) ? readFileSync(join(root, JOURNAL), 'utf8') : undefined,
      )
    : [];
  problems.push(...journal);

  const baseFiles = new Set(atBase.map((file) => file.path));
  return {
    base,
    baseWas,
    held: atBase.length,
    free: filesNow(root).filter((path) => !baseFiles.has(path)).length,
    problems,
  };
}

function usage(): never {
  process.stderr.write('Usage: node scripts/migration-immutability.ts [--base <revision>]\n');
  process.exit(2);
}

function main(argv: readonly string[]): number {
  let explicit: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') {
      explicit = argv[(index += 1)];
      if (explicit === undefined) usage();
    } else usage();
  }
  try {
    const report = checkMigrationImmutability({ root: process.cwd(), base: explicit });
    const where = `${report.base.slice(0, 12)} (${report.baseWas})`;
    if (report.problems.length > 0) {
      process.stderr.write(
        `A migration that main has was changed (base ${where}):\n${report.problems.map((line) => `  ${line}`).join('\n')}\n`,
      );
      return 1;
    }
    process.stdout.write(
      `Migrations held: ${String(report.held)} files of the base ${where} are unchanged; ${String(report.free)} others are not on main yet and are free to change.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof MigrationImmutabilityError) {
      process.stderr.write(`Cannot tell whether a migration was changed: ${error.message}\n`);
      if (inCi(process.env)) return 2;
      process.stderr.write(
        'Warning, not a failure: this is not a CI run (CI is not "true"), so nothing was held and the precheck goes on. CI has the whole history and fails on this. Name a revision of this tree with MELARC_MIGRATION_BASE or --base to hold the migrations here.\n',
      );
      return 0;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
