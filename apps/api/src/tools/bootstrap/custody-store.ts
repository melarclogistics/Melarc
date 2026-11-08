import { BootstrapCustodyError } from './bootstrap-vocabulary.js';
import {
  bundleTargetOf,
  isBundleFileName,
  renderBundle,
  startsLikeBundle,
  type BundleContent,
} from './custody-bundle.js';

/**
 * The writing of a custody bundle (S0.30; MIGRATION_AND_SEEDING.md §3.2), over two small ports so that the order of its steps, which
 * is the point, is shown without a disk: the folder (`CustodyDisk`) and the access to a file (`PrivateAccess`). The adapters over
 * `node:fs` and, on Windows, `icacls` are `custody-node.ts`, bound in the composition root.
 *
 * **The secret reaches the file last.** The file is created empty and exclusively (an existing name is refused, never overwritten),
 * then made private to the user who runs the command, then **inspected**, and only a file that the inspection found private is
 * written to. A file that cannot be made private, or whose access cannot be inspected, is removed empty: the secret never existed
 * anywhere that more than the operator could read. **A removal can fail**, and then the file stays: it is empty here, and after a
 * later failure (a partial write, a failed sync or close) it may hold the secret, whole or in part, so it is reported by its random
 * name in the error and the command tells the operator to delete it (A05). On POSIX the mode is set and the owner and the link count are read; on Windows the
 * inheritance is removed, the user alone is granted access and the resulting list is read back and judged (`custody-acl.ts`).
 */

/** One file made by `createExclusive`, open for the one write that gives it its content. */
export interface CustodyFile {
  write(content: string): Promise<void>;
  close(): Promise<void>;
}

export interface CustodyDisk {
  /** Makes the folder, privately, when it is not there. */
  ensureDirectory(directory: string): Promise<void>;
  /** Refuses (`DIRECTORY_NOT_PRIVATE`) a folder that others could read or enter, where the file system has permission bits to say so. */
  assertPrivateDirectory(directory: string): void;
  /** The names in the folder, no more. */
  listNames(directory: string): Promise<readonly string[]>;
  /** The first `bytes` bytes of a file as text. */
  readHead(path: string, bytes: number): Promise<string>;
  /** Creates an empty file that did not exist, or refuses with `FILE_EXISTS`. */
  createExclusive(path: string): Promise<CustodyFile>;
  /** Removes a file; resolves whether it did (a file that is not there is not an error). */
  remove(path: string): Promise<boolean>;
  join(directory: string, name: string): string;
}

export type AccessVerdict = 'PRIVATE' | 'REFUSED' | 'UNVERIFIED';

export interface PrivateAccess {
  /** Makes the file private to the user running the command. */
  secure(path: string): Promise<void>;
  /** Reads back the access to the file and judges it; `UNVERIFIED` when it could not be read. */
  inspect(path: string): Promise<AccessVerdict>;
  /**
   * Judges the access to the **folder**, before any file is made in it: a file takes its first access list from the folder, and a
   * handle opened by someone else while it was still open to them outlives the change that makes it private. `UNVERIFIED` when it
   * could not be read. On POSIX the disk's own check of the mode and the owner is the judgement, and this has nothing to add.
   */
  inspectDirectory(path: string): Promise<AccessVerdict>;
}

export interface WrittenBundle {
  /** The name of the file, which carries nothing of the custodian: safe to print. */
  readonly name: string;
  /** Where it is: never printed. */
  readonly path: string;
}

/** Enough to read the magic line of a bundle and the target on the line after it, and to tell it from any other file. */
const HEAD_BYTES = 160;

/** What a sweep of the folder did: the bundles it removed, and how many it found that are not provably this run's and left alone. */
export interface Swept {
  readonly removed: readonly string[];
  readonly kept: number;
}

export class CustodyStore {
  readonly #disk: CustodyDisk;
  readonly #access: PrivateAccess;
  readonly #randomName: () => string;

  /** `randomName` returns 32 lower-case hexadecimal digits from a secure source. */
  constructor(disk: CustodyDisk, access: PrivateAccess, randomName: () => string) {
    this.#disk = disk;
    this.#access = access;
    this.#randomName = randomName;
  }

  /**
   * Makes the folder and checks it: the mode and the owner where the file system has them, and, where it has an access list instead,
   * the list. A folder that the system could not judge private is refused like one that was judged not to be.
   */
  async prepare(directory: string): Promise<void> {
    await this.#disk.ensureDirectory(directory);
    this.#disk.assertPrivateDirectory(directory);
    if ((await this.#access.inspectDirectory(directory)) !== 'PRIVATE') {
      throw new BootstrapCustodyError('DIRECTORY_NOT_PRIVATE');
    }
  }

  /**
   * Removes the bundles of an earlier run that did not commit: a file whose name is a bundle's, whose first line is the bundle magic
   * **and whose target is this database's**. Any other file is left alone, whatever its name, and so is a bundle of another database
   * (it belongs to a pair that did commit, and is the only copy of a secret that is still to be handed over) or of a layout that names
   * no target: it is counted, so that the operator is told. Called only when the staff table is empty and under the lock that
   * `melarc.bootstrap_status` took, so that no other run against this database is between writing its bundles and committing its pair.
   */
  async sweepOrphans(directory: string, target: string): Promise<Swept> {
    const removed: string[] = [];
    let kept = 0;
    for (const name of await this.#disk.listNames(directory)) {
      if (!isBundleFileName(name)) continue;
      const path = this.#disk.join(directory, name);
      let head: string;
      try {
        head = await this.#disk.readHead(path, HEAD_BYTES);
      } catch {
        // A file that cannot be read is not one the command can say is its own, and is left for the operator.
        continue;
      }
      if (!startsLikeBundle(head)) continue;
      if (bundleTargetOf(head) !== target) {
        kept += 1;
        continue;
      }
      if (await this.#disk.remove(path)) removed.push(name);
    }
    return { removed, kept };
  }

  /**
   * Writes one bundle, in the order above, and resolves where it is. Rejects with a `BootstrapCustodyError` and **removes the file
   * it made**; if that removal fails the file is still there, and the error says so: `residual` holds its random name (never its
   * path), because the file may hold the secret, whole or in part. A rejection therefore leaves no file *unless it reports one*.
   */
  async write(directory: string, content: BundleContent): Promise<WrittenBundle> {
    const name = `melarc-bootstrap-${this.#randomName()}.bundle`;
    if (!isBundleFileName(name)) throw new BootstrapCustodyError('WRITE_FAILED');
    const path = this.#disk.join(directory, name);
    const file = await this.#create(path);
    try {
      await this.#access.secure(path);
      const verdict = await this.#access.inspect(path);
      if (verdict === 'REFUSED') throw new BootstrapCustodyError('ACCESS_REFUSED');
      if (verdict !== 'PRIVATE') throw new BootstrapCustodyError('ACCESS_UNVERIFIED');
      await file.write(renderBundle(content));
      await file.close();
    } catch (error) {
      // The handle is released first (a file in use cannot be removed on Windows), and the removal is tried whether or not it was. A
      // file that could not be removed may hold the secret, whole or in part, for a pair that will never be made: it is reported, by
      // its random name, in the error that carries the primary failure (the audit of 21 October 2026, A05). A file that was not there
      // any more is gone, which is what was wanted.
      await file.close().catch(() => undefined);
      const removed = await this.#disk.remove(path).then(
        () => true,
        () => false,
      );
      const residual = removed ? [] : [name];
      // What the file system said may name the path, and nothing here may: the rule that was broken is all that is passed on.
      throw new BootstrapCustodyError(
        error instanceof BootstrapCustodyError ? error.problem : 'WRITE_FAILED',
        residual,
      );
    }
    return { name, path };
  }

  async #create(path: string): Promise<CustodyFile> {
    try {
      return await this.#disk.createExclusive(path);
    } catch (error) {
      throw error instanceof BootstrapCustodyError
        ? error
        : new BootstrapCustodyError('WRITE_FAILED');
    }
  }

  /** Removes bundles this run wrote because its pair did not commit. Resolves the names it could not remove. */
  async discard(written: readonly WrittenBundle[]): Promise<readonly string[]> {
    const stuck: string[] = [];
    for (const bundle of written) {
      try {
        // A file that is already gone is not stuck; one that could not be removed is, and the operator is told which.
        await this.#disk.remove(bundle.path);
      } catch {
        stuck.push(bundle.name);
      }
    }
    return stuck;
  }
}
