import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  checkoutRootOf,
  isInside,
  resolvedPath,
} from '../../platform/delivery/worker/outside-checkout.js';
import { BootstrapCustodyError } from './bootstrap-vocabulary.js';
import { descriptorOf, inspectDirectorySddl, inspectSddl, type AclFinding } from './custody-acl.js';
import type { AccessVerdict, CustodyDisk, CustodyFile, PrivateAccess } from './custody-store.js';

/**
 * The adapters of the custody store over `node:fs` and, on Windows, `icacls` (S0.30; MIGRATION_AND_SEEDING.md §3.2). They are bound
 * by the composition root (`bootstrap-runtime.ts`) and by nothing else: the command's own logic reaches the file system only through
 * the ports of `custody-store.ts`.
 *
 * Nothing here puts a path, a secret or the words of the file system in an error: a failure is the one rule it broke
 * (`BootstrapCustodyError`), and the store passes on no other.
 */

const isErrorWith = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;

export class NodeCustodyDisk implements CustodyDisk {
  async ensureDirectory(directory: string): Promise<void> {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw new BootstrapCustodyError('WRITE_FAILED');
    }
  }

  /**
   * On POSIX: the folder is a directory, belongs to the user running the command, and grants nothing to group or others. On
   * Windows Node reports no permission bits, so nothing is judged here: the access list of the folder is judged by
   * `WindowsPrivateAccess.inspectDirectory`, which the store asks for next, and that of each file is written and read back before
   * anything is put in it.
   */
  assertPrivateDirectory(directory: string): void {
    if (process.platform === 'win32') return;
    // Synchronous on purpose (the port is): a stat of one folder, once, before anything else is done.
    let found: ReturnType<typeof statSync>;
    try {
      found = statSync(directory);
    } catch {
      throw new BootstrapCustodyError('DIRECTORY_NOT_PRIVATE');
    }
    const owner = process.getuid?.();
    if (
      !found.isDirectory() ||
      (owner !== undefined && found.uid !== owner) ||
      (found.mode & 0o077) !== 0
    ) {
      throw new BootstrapCustodyError('DIRECTORY_NOT_PRIVATE');
    }
  }

  async listNames(directory: string): Promise<readonly string[]> {
    try {
      return await readdir(directory);
    } catch (error) {
      if (isErrorWith(error, 'ENOENT')) return [];
      throw new BootstrapCustodyError('WRITE_FAILED');
    }
  }

  async readHead(path: string, bytes: number): Promise<string> {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async createExclusive(path: string): Promise<CustodyFile> {
    let handle;
    try {
      // `wx` fails if the name exists, a link included: exclusive creation. 0600 is the most the file is ever created with.
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      throw new BootstrapCustodyError(
        isErrorWith(error, 'EEXIST') ? 'FILE_EXISTS' : 'WRITE_FAILED',
      );
    }
    const opened = handle;
    return {
      write: async (content) => {
        await opened.writeFile(content, 'utf8');
        await opened.sync();
      },
      close: () => opened.close(),
    };
  }

  async remove(path: string): Promise<boolean> {
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (isErrorWith(error, 'ENOENT')) return false;
      throw error;
    }
  }

  join(directory: string, name: string): string {
    return join(directory, name);
  }
}

/** 32 lower-case hexadecimal digits from the platform's secure generator: the random part of a bundle's name. */
export const randomBundleName = (): string => randomBytes(16).toString('hex');

/**
 * POSIX: mode `0600`, then read back: a regular file (not a link), owned by the user running the command, no permission for group or
 * others, and one link (a second name for the file is a second way to it).
 */
export class PosixPrivateAccess implements PrivateAccess {
  async secure(path: string): Promise<void> {
    await chmod(path, 0o600);
  }

  /** Nothing to add: the disk's `assertPrivateDirectory` judged the mode and the owner of the folder before the store asked. */
  inspectDirectory(): Promise<AccessVerdict> {
    return Promise.resolve('PRIVATE');
  }

  async inspect(path: string): Promise<AccessVerdict> {
    let found;
    try {
      found = await lstat(path);
    } catch {
      return 'UNVERIFIED';
    }
    const owner = process.getuid?.();
    if (owner === undefined) return 'UNVERIFIED';
    const private_ =
      found.isFile() &&
      !found.isSymbolicLink() &&
      found.uid === owner &&
      (found.mode & 0o077) === 0 &&
      found.nlink === 1;
    return private_ ? 'PRIVATE' : 'REFUSED';
  }
}

/** What a run of a system program gives back: its text, or a failure. Replaceable, so that the sequence is shown without icacls. */
export type RunProgram = (file: string, args: readonly string[]) => Promise<string>;

const SYSTEM32 = (): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/** The longest a program of System32 (`whoami`, `icacls`) may take before it is ended and the run fails. */
export const PROGRAM_TIMEOUT_MS = 15_000;

/**
 * The most programs the files of one seed run: the user's SID once (`whoami`), and for each of the two bundles the setting of its
 * access (`icacls`) and the reading of it back (`icacls /save`). The deadlines of the transaction they run inside are built from it
 * (`BOOTSTRAP_DEADLINES`, `bootstrap-runtime.ts`).
 */
export const PROGRAMS_PER_SEED_RUN = 1 + 2 * 2;

/** Runs a program of System32 by its full path (never one found on the PATH), with no shell and a time limit. */
export const runSystemProgram: RunProgram = (file, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      join(SYSTEM32(), file),
      [...args],
      { windowsHide: true, timeout: PROGRAM_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout) => {
        if (error === null) resolvePromise(stdout);
        else reject(new Error('the program failed'));
      },
    );
  });

/** Decodes what `icacls /save` wrote: UTF-16 with no byte order mark on Windows, and UTF-8 if it was ever that. */
function decodeSaved(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return bytes.subarray(2).toString('utf16le');
  return bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8');
}

/**
 * Windows: the inheritance is removed and the user alone is granted access (`icacls /inheritance:r /grant:r *<SID>:(F)`: by SID, so
 * that the language of the machine and the spelling of the account do not matter), and the resulting list is saved in SDDL form
 * (`icacls /save`), read back and judged by `custody-acl.ts`: protected, nothing inherited, nobody broad, nobody but the user, the
 * system and the administrators. A POSIX mode alone is not access control there, which is why the list is read and not assumed.
 */
export class WindowsPrivateAccess implements PrivateAccess {
  readonly #run: RunProgram;
  #sid: string | undefined;

  constructor(run: RunProgram = runSystemProgram) {
    this.#run = run;
  }

  async #userSid(): Promise<string> {
    if (this.#sid !== undefined) return this.#sid;
    const csv = await this.#run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
    const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(csv)?.[1];
    if (sid === undefined) throw new Error('no SID');
    this.#sid = sid;
    return sid;
  }

  async secure(path: string): Promise<void> {
    const sid = await this.#userSid();
    await this.#run('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`]);
  }

  inspect(path: string): Promise<AccessVerdict> {
    return this.#judged(path, inspectSddl);
  }

  /**
   * The folder before any file is made in it: the list may be inherited from its parent (a folder in the user's profile is), but it
   * may not name anyone but the user, the local system and the administrators (`inspectDirectorySddl`). This only reads it: the
   * command changes no list of a folder it was given.
   */
  inspectDirectory(path: string): Promise<AccessVerdict> {
    return this.#judged(path, inspectDirectorySddl);
  }

  async #judged(
    path: string,
    judge: (descriptor: string, userSid: string) => AclFinding,
  ): Promise<AccessVerdict> {
    let scratch: string | undefined;
    try {
      const sid = await this.#userSid();
      scratch = await mkdtemp(join(tmpdir(), 'melarc-acl-'));
      const saved = join(scratch, 'saved.txt');
      await this.#run('icacls.exe', [path, '/save', saved]);
      const descriptor = descriptorOf(decodeSaved(await readFile(saved)));
      if (descriptor === undefined) return 'UNVERIFIED';
      const finding = judge(descriptor, sid);
      if (finding.ok) return 'PRIVATE';
      return finding.problem === 'UNPARSEABLE' ? 'UNVERIFIED' : 'REFUSED';
    } catch {
      return 'UNVERIFIED';
    } finally {
      if (scratch !== undefined)
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** The access of this platform: `icacls` on Windows, the mode and the owner everywhere else. */
export const privateAccessFor = (platform: NodeJS.Platform = process.platform): PrivateAccess =>
  platform === 'win32' ? new WindowsPrivateAccess() : new PosixPrivateAccess();

/**
 * The folder the bundles go in: named by the operator, absolute, and **outside any checkout** the process can be said to run from
 * (the working directory's, the application's own), wherever the path leads: a link, a junction, a short name or a case that
 * differs puts a folder inside the checkout though its written path is outside it, so both are compared as the system resolves them.
 * The source package is built from the checkout, so a bundle in it could end up in an archive that is shared for review.
 */
export function assertCustodyDirectory(
  directory: string | undefined,
  startingPoints: readonly string[],
): string {
  if (directory === undefined || directory.trim() === '')
    throw new BootstrapCustodyError('DIRECTORY_MISSING');
  if (!isAbsolute(directory)) throw new BootstrapCustodyError('DIRECTORY_NOT_ABSOLUTE');
  const where = resolvedPath(directory);
  for (const start of startingPoints) {
    const root = checkoutRootOf(start);
    if (root === undefined) continue;
    if (isInside(directory, root) || isInside(where, resolvedPath(root))) {
      throw new BootstrapCustodyError('DIRECTORY_INSIDE_CHECKOUT');
    }
  }
  return resolve(directory);
}
