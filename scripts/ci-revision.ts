/**
 * Ties what CI tests and publishes to the commit it is about.
 *
 *   checkout                 HEAD is the revision under test (GITHUB_SHA), not a branch tip or a moved merge ref.
 *   clean                    No tracked or unignored file differs from that commit: no tool rewrote the source or a
 *                            generated file during the run, and nothing that should be committed is left over.
 *   manifest <out> <root>... Records the revision, the toolchain, the lockfile and contract hashes and every file of
 *                            the given roots, so a published build can be checked against what was tested.
 *   verify <manifest>        Refuses a manifest that is empty, malformed or at odds with itself; recomputes the files
 *                            of its roots and reports any that changed, went missing or were added; and, in a Git
 *                            checkout, requires HEAD to be the revision the manifest describes. That is all it
 *                            establishes: matching checksums do not authenticate an artifact, and nothing here
 *                            knows whether CI succeeded for the revision. Check the run and the branch separately.
 *
 * Every check fails closed: a missing GITHUB_SHA, a root that does not exist or holds nothing, a link inside a
 * root and an unreadable manifest are errors, never a pass. It only reads; `manifest` writes the one file named.
 *
 * Usage: node scripts/ci-revision.ts <command> [arguments]   (run at the repository root)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from './workflow-shapes.ts';

export interface RevisionEnv {
  GITHUB_SHA?: string | undefined;
  GITHUB_REF?: string | undefined;
  GITHUB_RUN_ID?: string | undefined;
  GITHUB_RUN_ATTEMPT?: string | undefined;
  GITHUB_JOB?: string | undefined;
}

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BuildManifest {
  schema: 1;
  source: {
    revision: string;
    ref: string | null;
    runId: string | null;
    runAttempt: string | null;
    job: string | null;
  };
  toolchain: { node: string; packageManager: string };
  inputs: { lockfileSha256: string; contractSha256: string };
  roots: string[];
  files: ManifestFile[];
}

const SHOWN_PATHS = 10;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why HEAD is not the revision under test, or undefined when it is. */
export function checkoutProblem(cwd: string, env: RevisionEnv): string | undefined {
  const expected = env.GITHUB_SHA?.trim().toLowerCase();
  if (expected === undefined || expected === '') {
    return 'GITHUB_SHA is not set, so the revision under test is unknown.';
  }
  let head: string;
  try {
    head = git(cwd, 'rev-parse', 'HEAD').trim();
  } catch (error) {
    return `Cannot read HEAD: ${messageOf(error)}`;
  }
  return head === expected
    ? undefined
    : `HEAD is ${head}, not the revision under test ${expected}. Check out ref: github.sha.`;
}

/** Why the working tree differs from the commit, or undefined when it does not. Ignored files do not count. */
export function treeProblem(cwd: string): string | undefined {
  let status: string;
  try {
    status = git(cwd, 'status', '--porcelain', '--untracked-files=all');
  } catch (error) {
    return `Cannot read the working tree status: ${messageOf(error)}`;
  }
  const changes = status.split('\n').filter((line) => line !== '');
  if (changes.length === 0) return undefined;
  const shown = changes.slice(0, SHOWN_PATHS).map((line) => line.slice(3));
  const more = changes.length - shown.length;
  return (
    `The working tree is not the committed revision; ${String(changes.length)} path(s) differ: ` +
    shown.join(', ') +
    (more > 0 ? `, and ${String(more)} more.` : '.')
  );
}

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function hashFile(cwd: string, path: string): ManifestFile {
  const content = readFileSync(join(cwd, path));
  return { path, sha256: sha256Of(content), bytes: content.length };
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * A repository-relative POSIX path that stays inside the repository and clear of Git's own data, in its one
 * canonical form (no `.`, empty or trailing segment). `what` names the kind of path in the error message.
 */
function normalizeRepoPath(path: string, what: string): string {
  const refused = (why: string): Error =>
    new Error(`Invalid ${what} ${JSON.stringify(path)}: ${why}.`);
  if (path.includes('\\')) throw refused('use forward slashes');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw refused('it must be relative');
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw refused('it names nothing');
  if (segments.includes('..')) throw refused('it leaves the repository');
  if (segments[0] === '.git') throw refused('it is Git data');
  return segments.join('/');
}

const normalizeRoot = (root: string): string => normalizeRepoPath(root, 'root');

/** Every file under a root (the root itself when it is a file). A link or special file throws. */
function listFiles(cwd: string, root: string): ManifestFile[] {
  const files: ManifestFile[] = [];
  const visit = (path: string): void => {
    const stats = lstatSync(join(cwd, path));
    if (stats.isDirectory()) {
      for (const name of readdirSync(join(cwd, path)).sort()) visit(`${path}/${name}`);
    } else if (stats.isFile()) {
      files.push(hashFile(cwd, path));
    } else {
      throw new Error(`"${path}" is a link or special file; only plain files can be recorded.`);
    }
  };
  visit(root);
  return files;
}

function packageManagerOf(cwd: string): string {
  const packageJson: unknown = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const value = isRecord(packageJson) ? packageJson.packageManager : undefined;
  if (typeof value !== 'string') throw new Error('package.json has no packageManager.');
  return value;
}

const orNull = (value: string | undefined): string | null => value ?? null;

/** Describes the build output under `roots`. Refuses a tree that is not the revision under test. */
export function createManifest(
  cwd: string,
  roots: readonly string[],
  env: RevisionEnv,
): BuildManifest {
  if (roots.length === 0) throw new Error('Name at least one root to record.');
  const normalized = [...new Set(roots.map(normalizeRoot))].sort();

  const checkout = checkoutProblem(cwd, env);
  if (checkout !== undefined) throw new Error(checkout);
  const tree = treeProblem(cwd);
  if (tree !== undefined) throw new Error(tree);

  const files = new Map<string, ManifestFile>();
  for (const root of normalized) {
    let found: ManifestFile[];
    try {
      found = listFiles(cwd, root);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Root "${root}" does not exist. Was the build run?`, { cause: error });
      }
      throw error;
    }
    if (found.length === 0)
      throw new Error(`Root "${root}" holds no file. Did the build produce nothing?`);
    for (const file of found) files.set(file.path, file);
  }

  return {
    schema: 1,
    source: {
      revision: git(cwd, 'rev-parse', 'HEAD').trim(),
      ref: orNull(env.GITHUB_REF),
      runId: orNull(env.GITHUB_RUN_ID),
      runAttempt: orNull(env.GITHUB_RUN_ATTEMPT),
      job: orNull(env.GITHUB_JOB),
    },
    toolchain: { node: process.version, packageManager: packageManagerOf(cwd) },
    inputs: {
      lockfileSha256: hashFile(cwd, 'pnpm-lock.yaml').sha256,
      contractSha256: hashFile(cwd, 'contracts/openapi.yaml').sha256,
    },
    roots: normalized,
    files: [...files.values()].sort(byPath),
  };
}

/** The differences between the files on disk and the manifest, in path order. Empty means they match. */
export function verifyManifest(cwd: string, manifest: BuildManifest): string[] {
  // Defense in depth: readManifest refuses this, and a manifest built another way must not verify vacuously.
  if (manifest.files.length === 0)
    return ['the manifest lists no files, so there is nothing to verify'];
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  const actual = new Map<string, ManifestFile>();
  const found: { path: string; message: string }[] = [];

  for (const root of manifest.roots) {
    try {
      for (const file of listFiles(cwd, root)) actual.set(file.path, file);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      found.push({ path: root, message: `unsupported: ${root} (${messageOf(error)})` });
    }
  }

  for (const [path, expected] of listed) {
    const now = actual.get(path);
    if (now === undefined) found.push({ path, message: `missing: ${path}` });
    else if (now.sha256 !== expected.sha256) found.push({ path, message: `changed: ${path}` });
  }
  for (const path of actual.keys()) {
    if (!listed.has(path)) found.push({ path, message: `unlisted: ${path}` });
  }
  return found.sort(byPath).map(({ message }) => message);
}

/** A Git object name: 40 hexadecimal characters (SHA-1) or 64 (a SHA-256 repository), lower case. */
const GIT_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTRACT_PATH = 'contracts/openapi.yaml';

/** Whether `value` is an object with exactly these keys: a field nobody asked for is not carried along. */
function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

/**
 * Reads a build manifest and returns it only if it can describe a real build. A manifest is evidence about a
 * build, so one that is empty, malformed or at odds with itself is refused whole: verifying files against it
 * would pass vacuously, or against something other than what the build was. Every field is checked, nothing
 * unknown is accepted, and paths go through the same normalization the generator uses.
 */
export function readManifest(file: string): BuildManifest {
  const unreadable = (why: string): Error =>
    new Error(`Not a readable build manifest (${file}): ${why}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw unreadable(messageOf(error));
  }
  if (!isRecord(parsed)) throw unreadable('it is not an object');
  if (parsed.schema !== 1) throw unreadable('its schema is not 1');
  const required = ['schema', 'source', 'toolchain', 'inputs', 'roots', 'files'];
  const lacking = required.filter((key) => !(key in parsed));
  if (lacking.length > 0) throw unreadable(`it lacks ${lacking.join(', ')}`);
  if (!hasExactly(parsed, required)) throw unreadable('it has an unknown field');

  const { source, toolchain, inputs, roots, files } = parsed;
  if (
    !isRecord(source) ||
    typeof source.revision !== 'string' ||
    !GIT_OBJECT_NAME.test(source.revision)
  ) {
    throw unreadable(
      'its revision is not a Git object name (40 or 64 lower-case hexadecimal characters)',
    );
  }
  const optionalText = ['ref', 'runId', 'runAttempt', 'job'];
  if (
    !hasExactly(source, ['revision', ...optionalText]) ||
    !optionalText.every((key) => source[key] === null || typeof source[key] === 'string')
  ) {
    throw unreadable('its source has an unknown field, or a run detail that is not text or null');
  }
  if (
    !isRecord(toolchain) ||
    !hasExactly(toolchain, ['node', 'packageManager']) ||
    typeof toolchain.node !== 'string' ||
    toolchain.node === '' ||
    typeof toolchain.packageManager !== 'string' ||
    toolchain.packageManager === ''
  ) {
    throw unreadable('its toolchain does not name the Node.js and package manager versions');
  }
  if (
    !isRecord(inputs) ||
    !hasExactly(inputs, ['lockfileSha256', 'contractSha256']) ||
    typeof inputs.lockfileSha256 !== 'string' ||
    !SHA256_HEX.test(inputs.lockfileSha256) ||
    typeof inputs.contractSha256 !== 'string' ||
    !SHA256_HEX.test(inputs.contractSha256)
  ) {
    throw unreadable(
      'its inputs are not two SHA-256 hashes (64 lower-case hexadecimal characters)',
    );
  }

  const canonical = (value: string, what: string): string => {
    let normalized: string;
    try {
      normalized = normalizeRepoPath(value, what);
    } catch (error) {
      throw unreadable(messageOf(error));
    }
    if (normalized !== value) {
      throw unreadable(
        `the ${what} ${JSON.stringify(value)} is not in canonical form (${normalized})`,
      );
    }
    return value;
  };

  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    !roots.every((root): root is string => typeof root === 'string')
  ) {
    throw unreadable('it lists no roots');
  }
  const rootPaths = roots.map((root) => canonical(root, 'root'));
  if (new Set(rootPaths).size !== rootPaths.length) throw unreadable('a root is listed twice');

  if (!Array.isArray(files)) throw unreadable('its files are not a list');
  if (files.length === 0) throw unreadable('it lists no files, so there is nothing to verify');
  const entries: ManifestFile[] = [];
  for (const entry of files) {
    if (!isRecord(entry) || !hasExactly(entry, ['path', 'sha256', 'bytes'])) {
      throw unreadable(
        'its files are malformed: an entry is not exactly a path, a sha256 and bytes',
      );
    }
    const { path, sha256, bytes } = entry;
    if (typeof path !== 'string') throw unreadable('its files are malformed: a path is not text');
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw unreadable(`the sha256 of ${path} is not 64 lower-case hexadecimal characters`);
    }
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw unreadable(`the bytes of ${path} is not a non-negative whole number`);
    }
    entries.push({ path: canonical(path, 'file path'), sha256, bytes });
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw unreadable('a file is listed twice');
  }

  const under = (path: string, root: string): boolean =>
    path === root || path.startsWith(`${root}/`);
  for (const entry of entries) {
    if (!rootPaths.some((root) => under(entry.path, root))) {
      throw unreadable(`${entry.path} lies outside every root`);
    }
  }
  for (const root of rootPaths) {
    if (!entries.some((entry) => under(entry.path, root))) {
      throw unreadable(`the root ${root} has no file listed under it`);
    }
  }
  const contract = entries.find((entry) => entry.path === CONTRACT_PATH);
  if (contract !== undefined && contract.sha256 !== inputs.contractSha256) {
    throw unreadable(`inputs.contractSha256 is not the hash listed for ${CONTRACT_PATH}`);
  }

  return {
    schema: 1,
    source: {
      revision: source.revision,
      ref: source.ref as string | null,
      runId: source.runId as string | null,
      runAttempt: source.runAttempt as string | null,
      job: source.job as string | null,
    },
    toolchain: { node: toolchain.node, packageManager: toolchain.packageManager },
    inputs: { lockfileSha256: inputs.lockfileSha256, contractSha256: inputs.contractSha256 },
    roots: rootPaths,
    files: entries,
  };
}

/**
 * Whether the directory is a Git checkout of the manifest's revision. A build is unpacked at the root of a
 * checkout of the commit it came from, which is also where this script comes from; HEAD being another commit
 * means the files are being judged by the wrong tooling and against the wrong source. Where there is no
 * checkout the check cannot be made, and the note says so rather than implying it was. Checkout files are not
 * hashed against the manifest's inputs: a Windows working copy may hold CRLF where CI held LF.
 */
function checkoutIdentity(cwd: string, revision: string): { problem?: string; note: string } {
  let head: string;
  try {
    head = git(cwd, 'rev-parse', 'HEAD').trim().toLowerCase();
  } catch {
    return {
      note: 'The revision was not checked against a checkout: this directory is not a Git checkout.',
    };
  }
  if (head === revision) return { note: `The checkout is at revision ${revision}.` };
  return {
    problem: `the checkout is at ${head}, but the manifest describes ${revision}. Check out ${revision} and unpack the build at its root.`,
    note: '',
  };
}

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The command line. Returns the exit status. */
export function runRevision(
  argv: readonly string[],
  env: RevisionEnv,
  cwd: string,
  { out, err }: Io,
): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'checkout': {
        const problem = checkoutProblem(cwd, env);
        if (problem !== undefined) {
          err(problem);
          return 1;
        }
        out(`Checked out ${git(cwd, 'rev-parse', 'HEAD').trim()}, the revision under test.`);
        return 0;
      }
      case 'clean': {
        const problem = treeProblem(cwd);
        if (problem !== undefined) {
          err(problem);
          return 1;
        }
        out('The working tree is the committed revision.');
        return 0;
      }
      case 'manifest': {
        const [target, ...roots] = rest;
        if (target === undefined || roots.length === 0) {
          err('Usage: ci-revision.ts manifest <output file> <root>...');
          return 1;
        }
        const manifest = createManifest(cwd, roots, env);
        writeFileSync(join(cwd, target), `${JSON.stringify(manifest, null, 2)}\n`);
        out(
          `Wrote ${target}: ${String(manifest.files.length)} files from revision ${manifest.source.revision}.`,
        );
        return 0;
      }
      case 'verify': {
        const [target] = rest;
        if (target === undefined) {
          err('Usage: ci-revision.ts verify <manifest file>');
          return 1;
        }
        const manifest = readManifest(join(cwd, target));
        const { revision } = manifest.source;
        const identity = checkoutIdentity(cwd, revision);
        const differences = [
          ...verifyManifest(cwd, manifest),
          ...(identity.problem === undefined ? [] : [identity.problem]),
        ];
        for (const difference of differences) err(difference);
        if (differences.length > 0) return 1;
        out(
          `Verified ${String(manifest.files.length)} files: their contents match ${target}, which describes revision ${revision}.`,
        );
        out(identity.note);
        out(
          `This checks file contents and the checkout only. It does not authenticate the artifact, and it does not show that CI succeeded for ${revision}: check the run and the branch separately.`,
        );
        return 0;
      }
      default:
        err('Usage: ci-revision.ts checkout | clean | manifest <file> <root>... | verify <file>');
        return 1;
    }
  } catch (error) {
    err(messageOf(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runRevision(process.argv.slice(2), process.env, process.cwd(), {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
}
