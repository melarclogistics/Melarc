import { BootstrapCustodyError } from '../tools/bootstrap/bootstrap-vocabulary.js';
import type {
  AccessVerdict,
  CustodyDisk,
  CustodyFile,
  PrivateAccess,
} from '../tools/bootstrap/custody-store.js';

/**
 * A folder and the access to its files in memory, for the tests of the custody store and of the bootstrap commands that want to
 * show the order of their steps, and what was ever written where, without a disk (S0.30). Every call is recorded in `calls`.
 */
export class FakeDisk implements CustodyDisk {
  readonly files = new Map<string, string>();
  readonly unreadable = new Set<string>();
  readonly stuck = new Set<string>();
  readonly calls: string[] = [];
  /** Every text ever written to any file, in order: what a secret can be looked for in. */
  readonly everWritten: string[] = [];
  failWrite = false;
  /** Fails the nth (1-based) call of `write`, and none other. */
  failWriteNumber: number | undefined;
  /** A write that stores this many characters of its text and then fails: the file is left holding part of the secret. */
  partialWriteChars: number | undefined;
  /** Limits `partialWriteChars` to the nth (1-based) call of `write`; every call when unset. */
  partialWriteNumber: number | undefined;
  /** A write that stores the whole text and then fails, as a failed `fsync` does. */
  failSyncAfterWrite = false;
  /** Every `close` fails: the handle is not released. */
  failClose = false;
  /** Paths whose removal says the file was not there (`false`), as `unlink` does for a missing name. */
  readonly gone = new Set<string>();
  /** When set, every `write` waits for it before it does anything: a write that is still in flight when the test says so. */
  writeGate: Promise<void> | undefined;
  #writes = 0;

  ensureDirectory(): Promise<void> {
    this.calls.push('ensureDirectory');
    return Promise.resolve();
  }

  assertPrivateDirectory(): void {
    this.calls.push('assertPrivateDirectory');
  }

  listNames(directory: string): Promise<readonly string[]> {
    const prefix = `${directory}/`;
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length)),
    );
  }

  readHead(path: string, bytes: number): Promise<string> {
    if (this.unreadable.has(path)) return Promise.reject(new Error(`EACCES ${path}`));
    return Promise.resolve((this.files.get(path) ?? '').slice(0, bytes));
  }

  createExclusive(path: string): Promise<CustodyFile> {
    this.calls.push('create');
    if (this.files.has(path)) return Promise.reject(new BootstrapCustodyError('FILE_EXISTS'));
    this.files.set(path, '');
    return Promise.resolve({
      write: async (text) => {
        this.calls.push('write');
        this.#writes += 1;
        if (this.writeGate !== undefined) await this.writeGate;
        if (this.failWrite || this.failWriteNumber === this.#writes) {
          throw new Error(`ENOSPC ${path}`);
        }
        if (
          this.partialWriteChars !== undefined &&
          (this.partialWriteNumber === undefined || this.partialWriteNumber === this.#writes)
        ) {
          const part = text.slice(0, this.partialWriteChars);
          this.everWritten.push(part);
          this.files.set(path, part);
          throw new Error(`ENOSPC ${path}`);
        }
        this.everWritten.push(text);
        this.files.set(path, text);
        if (this.failSyncAfterWrite) throw new Error(`EIO ${path}`);
      },
      close: () => {
        this.calls.push('close');
        return this.failClose ? Promise.reject(new Error(`EIO ${path}`)) : Promise.resolve();
      },
    });
  }

  remove(path: string): Promise<boolean> {
    this.calls.push('remove');
    if (this.stuck.has(path)) return Promise.reject(new Error(`EBUSY ${path}`));
    if (this.gone.has(path)) {
      this.files.delete(path);
      return Promise.resolve(false);
    }
    return Promise.resolve(this.files.delete(path));
  }

  join(directory: string, name: string): string {
    return `${directory}/${name}`;
  }
}

export class FakeAccess implements PrivateAccess {
  verdict: AccessVerdict = 'PRIVATE';
  /** What the folder's access list is judged to be, before any file is made in it. */
  directoryVerdict: AccessVerdict = 'PRIVATE';
  failSecure = false;

  constructor(private readonly disk: FakeDisk) {}

  secure(): Promise<void> {
    this.disk.calls.push('secure');
    return this.failSecure
      ? Promise.reject(new Error('icacls refused /secret/path'))
      : Promise.resolve();
  }

  inspect(): Promise<AccessVerdict> {
    this.disk.calls.push('inspect');
    return Promise.resolve(this.verdict);
  }

  inspectDirectory(): Promise<AccessVerdict> {
    this.disk.calls.push('inspectDirectory');
    return Promise.resolve(this.directoryVerdict);
  }
}
