/**
 * Prepares the two git-ignored settings files a developer needs, from their committed examples:
 *
 *   infrastructure/postgres/.env   the local PostgreSQL service and the database tools: three throwaway random
 *                                  passwords (cluster superuser, migration identity, runtime identity)
 *   apps/api/.env                  the API: its example, with DATABASE_URL pointing at the runtime identity
 *                                  using the runtime password and the host and port from the file above
 *
 * It never overwrites a file, never prints a password, and writes nothing unless it can write everything it was
 * asked to. Each file appears whole or not at all, so a killed run leaves nothing the next run would refuse to
 * repair (createPrivateFile says how). A file that already exists is left alone, and a DATABASE_URL in it that does not match the runtime
 * password is reported as a note (by name, never by value), because that fails only when the API starts.
 *
 * Usage: node scripts/setup-env.ts [directory]    (default: the repository this script is in)
 */

import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const PG_ENV = 'infrastructure/postgres/.env';
const API_ENV = 'apps/api/.env';
const PLACEHOLDER = 'CHANGE_ME';
const RUNTIME_USER = 'melarc_api_runtime';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '5432';
const API_DATABASE = 'melarc_dev';

/** A file cannot be prepared. The message names files and settings, never a value. */
export class SetupEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupEnvError';
  }
}

export interface SetupEnvResult {
  /** Files written, relative to the checkout, with forward slashes. */
  created: string[];
  /** Files that were already there. */
  leftAlone: string[];
  /** Things the developer should look at, without any secret in them. */
  notes: string[];
}

/** How a file is created: exclusively (never replacing one), readable and writable by its owner only. */
export interface CreateOptions {
  flag: 'wx';
  mode: number;
}

/** The file system operations that create a file. A test replaces them to see what is asked of the file system. */
export interface FileOperations {
  /** Writes the file (default: `fs.writeFileSync`). */
  write: (path: string, content: string, options: CreateOptions) => void;
  /** Gives an existing file a second name, failing when that name is taken (default: `fs.linkSync`). */
  link: (existing: string, created: string) => void;
}

export interface SetupEnvOptions {
  /** Produces one password. Real randomness by default; a test passes a predictable one. */
  random?: () => string;
  /** Replaces some file system operations; the rest are the real ones. */
  files?: Partial<FileOperations>;
}

const randomPassword = (): string => randomBytes(24).toString('hex');

function readExample(root: string, target: string): string {
  const example = `${target}.example`;
  const path = join(root, example);
  if (!existsSync(path))
    throw new SetupEnvError(`${example} is missing, so ${target} cannot be created.`);
  return readFileSync(path, 'utf8');
}

/** The value a settings file holds for `key`, or undefined when it is absent or empty. */
function valueIn(text: string, key: string): string | undefined {
  const value = parseEnv(text)[key];
  return value === undefined || value === '' ? undefined : value;
}

function runtimePasswordIn(pgEnv: string): string {
  const password = valueIn(pgEnv, 'MELARC_PG_RUNTIME_PASSWORD');
  if (password === undefined || password === PLACEHOLDER) {
    throw new SetupEnvError(
      `MELARC_PG_RUNTIME_PASSWORD in ${PG_ENV} is ${password === undefined ? 'not set' : `still ${PLACEHOLDER}`}, so ${API_ENV} cannot be created. Set it, or delete ${PG_ENV} to have it generated.`,
    );
  }
  return password;
}

function databaseUrl(pgEnv: string): string {
  const password = encodeURIComponent(runtimePasswordIn(pgEnv));
  const host = urlHost(valueIn(pgEnv, 'MELARC_PG_HOST') ?? DEFAULT_HOST);
  const port = valueIn(pgEnv, 'MELARC_PG_PORT') ?? DEFAULT_PORT;
  return `postgres://${RUNTIME_USER}:${password}@${host}:${port}/${API_DATABASE}`;
}

/** A host as a URL writes it: an IPv6 address has its colons inside brackets (`::1` becomes `[::1]`). */
function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function apiEnvFrom(example: string, url: string): string {
  const line = /^DATABASE_URL=.*$/m;
  if (!line.test(example)) {
    throw new SetupEnvError(`${API_ENV}.example has no DATABASE_URL line to fill in.`);
  }
  // A function replacer: the URL may hold `$` sequences that a string replacement would expand.
  return example.replace(line, () => `DATABASE_URL=${url}`);
}

/** Why an existing API settings file does not match the database file, or undefined when it does. */
function apiEnvNote(apiEnv: string, pgEnv: string): string | undefined {
  const unreadable = `${API_ENV} has no DATABASE_URL that can be read; set it to use the runtime identity with MELARC_PG_RUNTIME_PASSWORD from ${PG_ENV}.`;
  const given = valueIn(apiEnv, 'DATABASE_URL');
  if (given === undefined) return unreadable;
  let password: string;
  try {
    password = decodeURIComponent(new URL(given).password);
  } catch {
    return unreadable;
  }
  const expected = valueIn(pgEnv, 'MELARC_PG_RUNTIME_PASSWORD');
  if (expected !== undefined && password === expected) return undefined;
  return `The DATABASE_URL in ${API_ENV} does not use MELARC_PG_RUNTIME_PASSWORD from ${PG_ENV}, so the API will be refused by the database. Edit it, or delete ${API_ENV} to have it rebuilt.`;
}

const PRIVATE_FILE: CreateOptions = { flag: 'wx', mode: 0o600 };

/**
 * Creates `path` (relative to `root`) with all of `content` or not at all, and never replaces a file. The content
 * is written under another name in the same folder and then given its final name by a hard link, which fails
 * when that name is taken. A run killed while it writes therefore leaves no truncated settings file, which the
 * next run would refuse to repair because the file exists; at worst it leaves a `.env.tmp-*` file beside it
 * (git-ignored like every `.env.*`, and refused by name by the source package) that the next run ignores.
 *
 * The file is made private to its owner (0600) where the file system has permission bits. On Windows Node
 * applies no mode bits: a new file takes the access rights of its folder, so keep the checkout in your own
 * profile. Only a file system without hard links falls back to a check followed by a rename.
 */
export function createPrivateFile(
  root: string,
  path: string,
  content: string,
  files: Partial<FileOperations> = {},
): void {
  const write = files.write ?? writeFileSync;
  const link = files.link ?? linkSync;
  const target = join(root, path);
  const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  const taken = new SetupEnvError(`${path} already exists, so it was left alone.`);
  try {
    write(temporary, content, PRIVATE_FILE);
    try {
      link(temporary, target);
    } catch {
      // The name is taken, or this file system has no hard links: the first is refused, the second is moved.
      if (existsSync(target)) throw taken;
      renameSync(temporary, target);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Prepares the settings files under `root`. Everything is decided before anything is written, so a refusal
 * leaves the checkout as it was.
 */
export function setupLocalEnv(root: string, options: SetupEnvOptions = {}): SetupEnvResult {
  const random = options.random ?? randomPassword;
  const result: SetupEnvResult = { created: [], leftAlone: [], notes: [] };
  const writes: [path: string, content: string][] = [];

  let pgEnv: string;
  if (existsSync(join(root, PG_ENV))) {
    pgEnv = readFileSync(join(root, PG_ENV), 'utf8');
    result.leftAlone.push(PG_ENV);
  } else {
    // Only a setting's value is replaced: the example's own explanation names the placeholder too.
    pgEnv = readExample(root, PG_ENV).replace(
      new RegExp(`^([A-Z][A-Z0-9_]*=)${PLACEHOLDER}(\\r?)$`, 'gm'),
      (_match, assignment: string, lineEnd: string) => `${assignment}${random()}${lineEnd}`,
    );
    writes.push([PG_ENV, pgEnv]);
  }

  if (existsSync(join(root, API_ENV))) {
    const note = apiEnvNote(readFileSync(join(root, API_ENV), 'utf8'), pgEnv);
    if (note !== undefined) result.notes.push(note);
    result.leftAlone.push(API_ENV);
  } else {
    writes.push([API_ENV, apiEnvFrom(readExample(root, API_ENV), databaseUrl(pgEnv))]);
  }

  for (const [path, content] of writes) {
    createPrivateFile(root, path, content, options.files);
    result.created.push(path);
  }
  return result;
}

/** The command: prints what happened and what to do next, and returns the exit status. */
export function runSetupEnv(
  root: string,
  print: (line: string) => void,
  random?: () => string,
): number {
  let result: SetupEnvResult;
  try {
    result = setupLocalEnv(root, random === undefined ? {} : { random });
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 1;
  }
  for (const path of result.created) print(`created     ${path}`);
  for (const path of result.leftAlone) print(`left alone  ${path}`);
  for (const note of result.notes) print(`note: ${note}`);
  print('Next: pnpm run infra:up');
  return 0;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(dirname(import.meta.filename), '..'));
  const status = runSetupEnv(root, (line) => {
    console.log(line);
  });
  process.exitCode = status;
}
