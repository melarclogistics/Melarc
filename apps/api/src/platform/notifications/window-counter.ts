import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The count of messages a controlled real-provider window has sent (S1.12d; DEPLOYMENT_AND_ENVIRONMENTS.md §4.1). The window's cap is a
 * safety net for the owner's money and for the people the owner texts, so it must hold where a counter in memory would not: across a
 * restart of the worker and across two processes (the worker and the smoke command). It is a small file in the folder the worker already
 * keeps for its capture sink (outside the checkout, private to the user), guarded by a lock directory, which is atomic on every file
 * system this runs on.
 *
 * **It fails closed.** A count that cannot be read (damaged, or written for another window), and a count file that was there and is gone,
 * stop the sending with `WindowCounterUnreadableError`; neither is read as zero. A file that has never been written is a window that has
 * sent nothing, which is how every window starts; a process that deletes the folder's files between two runs of the worker, as the owner
 * may when clearing the capture folder, starts the count again, and renewing a window is done with a new approval reference, which has a
 * count of its own. (The owner's own act is not a defect to guard against; a file that vanishes under a running worker is.)
 *
 * It keeps the count and a digest of the approval reference, and nothing else: no number, no text, no credential.
 */

export interface WindowCounter {
  /** Takes one slot of the window: true while the cap holds, false once it is reached. Durable and safe across processes. */
  take(): Promise<boolean>;
  /** How many slots have been taken. */
  taken(): Promise<number>;
}

/** The count cannot be read, so no slot is given out until it is fixed or the window is renewed. */
export class WindowCounterUnreadableError extends Error {
  constructor() {
    super(
      'The count of the controlled window cannot be read, so nothing is sent: renew the window with a new approval reference.',
    );
    this.name = 'WindowCounterUnreadableError';
  }
}

/** The lock could not be taken in the time allowed: another process holds it, or the folder cannot be written. */
export class WindowCounterBusyError extends Error {
  constructor() {
    super('The count of the controlled window is held by another process.');
    this.name = 'WindowCounterBusyError';
  }
}

/** A lock older than this was left by a process that died holding it. */
const LOCK_STALE_MS = 10_000;
/** How long a caller waits for the lock before it gives up. */
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 10;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface FileWindowCounterOptions {
  /** A folder outside the checkout, private to the user (the worker's capture folder), made on first use where it does not exist. */
  readonly directory: string;
  /** The reference of the approval of the window: 4 to 64 letters, digits and . _ : - (never written to a file as it is). */
  readonly approvalRef: string;
  /** The most slots the window may give out: a whole number of at least one. */
  readonly cap: number;
}

export class FileWindowCounter implements WindowCounter {
  /** The name of the count file, from a digest of the approval reference (a reference may hold a colon, which a file name may not). */
  readonly fileName: string;
  /** The name of the lock directory beside it. */
  readonly lockName: string;
  readonly #directory: string;
  readonly #digest: string;
  readonly #cap: number;
  /** Whether this counter has read or written its file: a file it has seen and now misses is not a window that has sent nothing. */
  #seen = false;

  constructor(options: FileWindowCounterOptions) {
    if (!Number.isInteger(options.cap) || options.cap < 1) {
      throw new RangeError('The cap of a window is a whole number of at least one.');
    }
    this.#directory = options.directory;
    this.#cap = options.cap;
    this.#digest = createHash('sha256').update(options.approvalRef).digest('hex').slice(0, 32);
    this.fileName = `provider-window-${this.#digest}.count`;
    this.lockName = `provider-window-${this.#digest}.lock`;
  }

  take(): Promise<boolean> {
    return this.#locked(async () => {
      const taken = await this.#read();
      if (taken >= this.#cap) return false;
      await this.#write(taken + 1);
      return true;
    });
  }

  taken(): Promise<number> {
    return this.#locked(() => this.#read());
  }

  get #file(): string {
    return join(this.#directory, this.fileName);
  }

  get #lock(): string {
    return join(this.#directory, this.lockName);
  }

  async #locked<T>(work: () => Promise<T>): Promise<T> {
    // The folder is the worker's capture folder, which a worker that has captured nothing has not made yet. Private to the user where the
    // file system has permission bits to say so; the runtime has already judged where it is (outside the checkout, private).
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(this.#lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.#lockIsStale()) {
          await rm(this.#lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new WindowCounterBusyError();
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await work();
    } finally {
      await rm(this.#lock, { recursive: true, force: true });
    }
  }

  async #lockIsStale(): Promise<boolean> {
    try {
      return Date.now() - (await stat(this.#lock)).mtimeMs > LOCK_STALE_MS;
    } catch {
      // The lock went away between the failed take and this look: try again.
      return false;
    }
  }

  async #read(): Promise<number> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.#seen) return 0;
      throw new WindowCounterUnreadableError();
    }
    try {
      const parsed = JSON.parse(text) as { ref?: unknown; taken?: unknown };
      if (
        parsed.ref === this.#digest &&
        typeof parsed.taken === 'number' &&
        Number.isInteger(parsed.taken) &&
        parsed.taken >= 0
      ) {
        this.#seen = true;
        return parsed.taken;
      }
    } catch {
      // Falls through to the refusal.
    }
    throw new WindowCounterUnreadableError();
  }

  async #write(taken: number): Promise<void> {
    const staged = `${this.#file}.next`;
    await writeFile(staged, JSON.stringify({ ref: this.#digest, taken }), { mode: 0o600 });
    await rename(staged, this.#file);
    this.#seen = true;
  }
}
