/**
 * Packages the source of this repository as a ZIP for review, so an archive is made the same way every time and
 * never carries what must not leave the machine.
 *
 * `.gitignore` protects Git operations, not a ZIP made of the folder: the folder holds the populated settings files
 * (`apps/api/.env`, `infrastructure/postgres/.env`), the dependencies and the build output. This command starts from
 * what Git knows (tracked files plus untracked files that are not ignored), then refuses by name what it must not
 * ship (settings files, keys, package-manager credentials, dependency and output directories, scratch and Git
 * metadata, earlier archives) even when Git would include it, and finally reads the real values out of the local
 * settings files and fails if any of them appears inside a file it is about to pack. It reports paths and counts,
 * never a value, and it never changes, moves or deletes a file in the working tree.
 *
 * The archive holds the working tree as it is, so it can be reviewed before it is committed. SOURCE_PACKAGE.json at
 * its root names the revision it sits on, whether the working tree differs from it, and every file with its SHA-256,
 * so a modified tree is never presented as the commit. The same tree gives the same bytes: entries are sorted and
 * carry a fixed timestamp, and the file holds no clock.
 *
 * The ZIP writer is plain (no ZIP64): at most 65535 files and 4 GiB. It uses only Node built-ins.
 *
 * Usage: node scripts/package-source.ts [--out <file>] [--overwrite]
 *        default output: tmp/melarc-source-<revision>.zip (tmp/ is git-ignored); an existing file is never replaced
 *        without --overwrite
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';

export const PACKAGE_INFO_PATH = 'SOURCE_PACKAGE.json';

/** Shorter values cannot be told from ordinary text, so finding one inside a file would prove nothing. */
const MIN_SECRET_LENGTH = 12;
const PLACEHOLDER = 'CHANGE_ME';
const MAX_ENTRIES = 65_535;
const MAX_BYTES = 0xffff_ffff;

/** A package cannot be made. The message names files and settings, never a value. */
export class PackageSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageSourceError';
  }
}

export interface ZipEntry {
  path: string;
  data: Buffer;
}

export interface Excluded {
  path: string;
  reason: string;
}

export interface PackageOptions {
  /** Where to write the archive. Default: tmp/melarc-source-<revision>.zip in the repository. */
  out?: string;
  /** Replace an existing file at `out`. */
  overwrite?: boolean;
}

export interface PackageResult {
  out: string;
  /** Source files in the archive, not counting SOURCE_PACKAGE.json. */
  files: number;
  archiveBytes: number;
  revision: string | null;
  branch: string | null;
  /** Whether the working tree differs from `revision` (or there is no revision yet). */
  modified: boolean;
  changes: number;
  excluded: Excluded[];
  /** How many local secret values were looked for in every packed file. */
  secretValuesChecked: number;
}

// ---------------------------------------------------------------------------------------------------------------
// What may not be packed

const SETTINGS = 'local settings file';
const KEYS = 'private key or certificate file';
const CREDENTIALS = 'package-manager credentials file';
const DEPENDENCIES = 'dependencies';
const OUTPUT = 'build or test output';
const LOGS = 'log output';
const SCRATCH = 'local scratch files';
const GIT_METADATA = 'git history and configuration';
const AGENT_STATE = 'agent session state';
const ARCHIVE = 'earlier archive';

const DIRECTORY_REASONS = new Map<string, string>([
  ['.git', GIT_METADATA],
  ['node_modules', DEPENDENCIES],
  ['.pnpm-store', DEPENDENCIES],
  ['dist', OUTPUT],
  ['build', OUTPUT],
  ['out', OUTPUT],
  ['.turbo', OUTPUT],
  ['.vite', OUTPUT],
  ['.next', OUTPUT],
  ['coverage', OUTPUT],
  ['.nyc_output', OUTPUT],
  ['playwright-report', OUTPUT],
  ['test-results', OUTPUT],
  ['blob-report', OUTPUT],
  ['tmp', SCRATCH],
  ['temp', SCRATCH],
  ['.local-data', SCRATCH],
  ['.claude', AGENT_STATE],
  ['.superpowers', AGENT_STATE],
]);

const KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'];
const KEY_NAMES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.7z', '.rar'];

/**
 * Why a path (relative to the repository, with forward slashes) must not be packed, or undefined when it may be.
 * Directory names match whole path segments and everything is compared in lower case, so `distribution/` and
 * `keyboard.ts` are source and `Node_Modules/` and `SERVER.PEM` are not. A settings example (`.env.example`,
 * `.env.production.example`) is source.
 */
export function denyReason(path: string): string | undefined {
  const segments = path.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  for (const directory of segments.slice(0, -1)) {
    const reason = DIRECTORY_REASONS.get(directory);
    if (reason !== undefined) return reason;
  }
  // `.env`, `production.env`, `.env.local`, `.env.old`; not `.env.example`.
  if (name.endsWith('.env') || (name.startsWith('.env.') && !name.endsWith('.example'))) {
    return SETTINGS;
  }
  if (KEY_EXTENSIONS.some((extension) => name.endsWith(extension))) return KEYS;
  if (KEY_NAMES.some((prefix) => name.startsWith(prefix))) return KEYS;
  if (name === '.npmrc') return CREDENTIALS;
  if (ARCHIVE_EXTENSIONS.some((extension) => name.endsWith(extension))) return ARCHIVE;
  if (name.endsWith('.log')) return LOGS;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Local secrets

const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'credentials',
]);

/** Whether a setting's name says its value is a credential: PASSWORD, SECRET, TOKEN, ..._KEY, DATABASE_URL. */
export function secretKey(key: string): boolean {
  const lower = key.toLowerCase();
  const parts = lower.split('_');
  if (parts.some((part) => SECRET_WORDS.has(part))) return true;
  if (parts.at(-1) === 'key') return true;
  return /(?:^|_)(?:database_url|connection_string|dsn)$/.test(lower);
}

/** The password inside a URL such as postgresql://user:password@host/db, or undefined. */
function urlPassword(value: string): string | undefined {
  try {
    const { password } = new URL(value);
    return password === '' ? undefined : password;
  } catch {
    return undefined;
  }
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The credential values held by the given settings files (paths relative to `root`; a missing file is skipped): the
 * value of every setting whose name says it is a credential, and the password inside any URL. Values shorter than
 * twelve characters and placeholders are left out.
 */
export function readSecretValues(root: string, paths: readonly string[]): string[] {
  const values = new Set<string>();
  const add = (value: string): void => {
    if (value.length >= MIN_SECRET_LENGTH && !value.includes(PLACEHOLDER)) values.add(value);
  };
  for (const path of paths) {
    const file = join(root, path);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (value === undefined) continue;
      if (secretKey(key)) add(value);
      const password = urlPassword(value);
      if (password !== undefined) {
        add(password);
        add(decoded(password));
      }
    }
  }
  return [...values];
}

/** The paths of the files that contain any of the values, sorted, once each. Never the values. */
export function findLeaks(files: readonly ZipEntry[], values: readonly string[]): string[] {
  if (values.length === 0) return [];
  const leaking = new Set<string>();
  for (const file of files) {
    if (values.some((value) => file.data.includes(value))) leaking.add(file.path);
  }
  return [...leaking].sort();
}

// ---------------------------------------------------------------------------------------------------------------
// ZIP

/** 1980-01-01 00:00:00, the earliest time a ZIP can hold, so the archive does not depend on when it was made. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UNIX_FILE_0644 = (0o100644 << 16) >>> 0;
const MADE_BY_UNIX = (3 << 8) | 20;
const UTF8_NAMES = 0x0800;

/** A relative path of plain segments with forward slashes. An empty segment also rules out '', '/a' and 'a/'. */
function validZipPath(path: string): boolean {
  if (path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * A ZIP of the entries in the order given: names in UTF-8, deflated unless that does not make a file smaller, no
 * extra fields, a fixed timestamp, Unix mode 0644. The same entries give the same bytes.
 */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new PackageSourceError(
      `an archive without ZIP64 holds at most ${String(MAX_ENTRIES)} files, and ${String(entries.length)} were given`,
    );
  }
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const { path, data } of entries) {
    if (!validZipPath(path)) {
      throw new PackageSourceError(`not a valid archive path: ${JSON.stringify(path)}`);
    }
    if (seen.has(path))
      throw new PackageSourceError(`the path ${path} would be in the archive twice`);
    seen.add(path);
    if (data.length > MAX_BYTES)
      throw new PackageSourceError(`${path} is too large for an archive without ZIP64`);

    const name = Buffer.from(path, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(UNIX_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    directory.push(central, name);
    offset += local.length + name.length + body.length;
    if (offset > MAX_BYTES) throw new PackageSourceError('the archive is too large without ZIP64');
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

// ---------------------------------------------------------------------------------------------------------------
// Git

function git(root: string, args: readonly string[]): Buffer {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PackageSourceError('git is not installed or not on the PATH');
    }
    const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim() ?? '';
    throw new PackageSourceError(
      `git ${args.join(' ')} failed${stderr === '' ? '' : `: ${stderr}`}`,
    );
  }
}

/** The text of a NUL-separated git listing, without the empty entry after the last separator. */
function entriesOf(output: Buffer): string[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry !== '');
}

function sameDirectory(a: string, b: string): boolean {
  const one = realpathSync.native(a);
  const two = realpathSync.native(b);
  return process.platform === 'win32' ? one.toLowerCase() === two.toLowerCase() : one === two;
}

/** The root of the git checkout that contains `directory`. */
export function checkoutRoot(directory: string): string {
  let top: string;
  try {
    top = git(directory, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch (error) {
    if (error instanceof PackageSourceError && error.message.includes('not installed')) throw error;
    throw new PackageSourceError(
      `${directory} is not inside a git checkout, and the files to pack come from git`,
    );
  }
  return resolve(top);
}

export interface Change {
  /** Git's two-letter status: " M" modified, " D" deleted, "??" untracked, "A " added, and so on. */
  status: string;
  path: string;
}

/** The entries of `git status --porcelain=v1 -z`: "XY path", NUL-separated; a rename or copy adds the old path. */
export function parseStatus(output: Buffer): Change[] {
  const tokens = output.toString('utf8').split('\0');
  const changes: Change[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '') continue;
    const status = token.slice(0, 2);
    changes.push({ status, path: token.slice(3) });
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(status)) index += 1;
  }
  return changes;
}

function tryGit(root: string, args: readonly string[]): string | null {
  try {
    return git(root, args).toString('utf8').trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The package

/** `path` relative to `root`, with forward slashes. A path outside `root` starts with `..` and matches no file. */
function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function defaultOutput(root: string, revision: string | null, modified: boolean): string {
  const name = revision === null ? 'no-commit' : revision.slice(0, 12);
  return join(
    root,
    'tmp',
    `melarc-source-${name}${modified && revision !== null ? '-modified' : ''}.zip`,
  );
}

/**
 * Packs the repository at `root`, which must be the root of a git checkout, and returns what was done. Nothing is
 * written unless every check passes.
 */
export function packageSource(root: string, options: PackageOptions = {}): PackageResult {
  const top = checkoutRoot(root);
  if (!sameDirectory(top, root)) {
    throw new PackageSourceError(
      `${root} is inside the git checkout at ${top}, not its root: run this from ${top}`,
    );
  }

  const revision = tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const branch = tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const changes = parseStatus(
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
  const modified = revision === null || changes.length > 0;

  const out = resolve(options.out ?? defaultOutput(root, revision, modified));
  if (existsSync(out) && options.overwrite !== true) {
    throw new PackageSourceError(
      `${out} exists: choose another file with --out, or replace it with --overwrite`,
    );
  }
  const ownPath = relativePosix(root, out);

  const candidates = [
    ...new Set(
      entriesOf(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])),
    ),
  ];
  const listedIgnored = entriesOf(
    git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
  );
  // Git also lists a directory that holds nothing but ignored files, next to those files: keep the files.
  const ignored = listedIgnored.filter(
    (path) =>
      !(
        path.endsWith('/') &&
        listedIgnored.some((other) => other !== path && other.startsWith(path))
      ),
  );
  const excluded: Excluded[] = ignored.map((path) => ({ path, reason: 'ignored' }));

  const packed: ZipEntry[] = [];
  const described: { path: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  for (const path of candidates) {
    const reason = ownPath === path ? 'this archive' : denyReason(path);
    if (reason !== undefined) {
      excluded.push({ path, reason });
      continue;
    }
    let stat;
    try {
      stat = lstatSync(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      excluded.push({ path, reason: 'deleted in the working tree' });
      continue;
    }
    if (!stat.isFile()) {
      excluded.push({ path, reason: 'not a regular file' });
      continue;
    }
    const data = readFileSync(join(root, path));
    total += data.length;
    if (total > MAX_BYTES)
      throw new PackageSourceError('the source is too large for an archive without ZIP64');
    packed.push({ path, data });
    described.push({
      path,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }

  // The values to look for come from every settings file on disk: the ignored ones Git lists, and any that Git
  // would have packed if it had not been refused by name.
  const settingsFiles = [...ignored.filter((path) => !path.endsWith('/')), ...candidates].filter(
    (path) => denyReason(path) === SETTINGS,
  );
  const secrets = readSecretValues(root, settingsFiles);
  const leaks = findLeaks(packed, secrets);
  if (leaks.length > 0) {
    throw new PackageSourceError(
      `a local credential appears in ${leaks.join(', ')}. Nothing was written. Remove it from ${leaks.length === 1 ? 'that file' : 'those files'}` +
        ' and, if the file was shared, replace the credential. The value is not shown.',
    );
  }

  const byPath = (a: { path: string }, b: { path: string }): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  described.sort(byPath);
  excluded.sort(byPath);
  const counts: Record<string, number> = {};
  for (const { reason } of excluded) counts[reason] = (counts[reason] ?? 0) + 1;

  if (packed.some((entry) => entry.path === PACKAGE_INFO_PATH)) {
    throw new PackageSourceError(
      `${PACKAGE_INFO_PATH} already exists in the repository, so the package cannot describe itself`,
    );
  }
  const info = {
    schema: 1,
    tool: 'scripts/package-source.ts',
    revision,
    branch,
    workingTree: modified ? 'modified' : 'clean',
    changes,
    note: 'This archive holds the working tree as it was when it was made. When workingTree is "modified" it is not the commit named in revision; changes lists what differs. The files below are all it holds.',
    excluded: counts,
    files: described,
  };
  packed.push({
    path: PACKAGE_INFO_PATH,
    data: Buffer.from(`${JSON.stringify(info, null, 2)}\n`, 'utf8'),
  });
  packed.sort(byPath);

  const zip = writeZip(packed);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip, { flag: options.overwrite === true ? 'w' : 'wx' });

  return {
    out,
    files: described.length,
    archiveBytes: zip.length,
    revision,
    branch,
    modified,
    changes: changes.length,
    excluded,
    secretValuesChecked: secrets.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

const USAGE = 'Usage: node scripts/package-source.ts [--out <file>] [--overwrite]';

function parseArguments(args: readonly string[]): PackageOptions | undefined {
  const options: PackageOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--overwrite') {
      options.overwrite = true;
    } else if (argument === '--out') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      options.out = resolve(value);
      index += 1;
    } else {
      return undefined;
    }
  }
  return options;
}

/** Runs the command and returns its exit status. */
export function runPackageSource(
  args: readonly string[],
  directory: string,
  out: (line: string) => void,
  err: (line: string) => void,
): 0 | 1 {
  const options = parseArguments(args);
  if (options === undefined) {
    err(USAGE);
    return 1;
  }
  try {
    const result = packageSource(checkoutRoot(directory), options);
    const revision = result.revision === null ? 'no commit yet' : `revision ${result.revision}`;
    out(`Wrote ${result.out} (${String(result.archiveBytes)} bytes).`);
    out(
      `${String(result.files)} files from ${revision}${result.branch === null ? '' : ` on ${result.branch}`}.`,
    );
    out(
      result.modified
        ? `The working tree is modified (${String(result.changes)} changed paths), so this is not the commit: ${PACKAGE_INFO_PATH} lists the changes.`
        : 'The working tree is clean.',
    );
    const counts = new Map<string, number>();
    for (const { reason } of result.excluded) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    out(
      counts.size === 0
        ? 'Left out: nothing.'
        : `Left out: ${[...counts].map(([reason, count]) => `${String(count)} ${reason}`).join(', ')}.`,
    );
    out(
      result.secretValuesChecked === 0
        ? 'No local settings file held a credential to look for.'
        : `Looked for ${String(result.secretValuesChecked)} local credential values in every packed file: none found.`,
    );
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runPackageSource(
    process.argv.slice(2),
    process.cwd(),
    (line) => {
      console.log(line);
    },
    (line) => {
      console.error(line);
    },
  );
}
