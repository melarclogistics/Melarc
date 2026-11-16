import { createConnection, type Socket } from 'node:net';

import type {
  ContentScanner,
  ObjectBytes,
  ScanVerdict,
} from '../auth/ports/content-scanner.port.js';
import { currentBudget } from '../execution/execution-budget.js';
import { ContentScannerError } from './content-scanner-error.js';

/**
 * The ClamAV adapter of the content scanner (Run A2; the Product Owner's decision D-A6 of 12 November 2026). It speaks clamd's own protocol over TCP, to a daemon the deployment runs
 * beside the API (DEPLOYMENT_AND_ENVIRONMENTS.md, the release gate), and adds no dependency: `node:net` and the protocol, which is small.
 *
 * - **`INSTREAM`** (clamd(8)): the command `zINSTREAM\0`, then the object as frames, each a four-byte network-order length and that many bytes, then a frame of length zero; the reply is one
 *   line, `stream: OK`, `stream: <signature> FOUND` or `<reason> ERROR`, ended by `\0`. The object is **streamed from the store**: each frame is written as the bytes arrive, flushed before the
 *   next is read (so a slow daemon slows the read and memory stays at one frame), and **nothing is written to a disk**, here or by the daemon, which scans the stream in its own memory.
 * - **`VERSION`** (`zVERSION\0`) is asked first, on a connection of its own: the verdict names the version of the signatures it was made with (`ClamAV 1.4.2/27836/Wed Nov 12 08:05:44
 *   2026`), and a daemon that is down is found before ten megabytes are read. The version is read at or before the scan, so a database reloaded in between can only make the recorded
 *   version older than the one that scanned, never newer: the record never claims more freshness than the scan had.
 * - **A verdict is only what the daemon said, and only when the stream was whole.** `stream: OK` is `CLEAN`; `stream: <name> FOUND` is `FLAGGED`. Everything else is **a failure to decide**: a
 *   refused or reset connection, a daemon that does not answer within the call's deadline, a reply that ends in `ERROR` (`INSTREAM size limit exceeded` among them: the daemon's
 *   `StreamMaxLength` must be above `evidence_upload_max_bytes`), a reply that is not a reply, **a reply that came before the object had been sent** (the daemon answered a stream it had not
 *   finished reading), and **a failure that was recorded beside a reply that is present** (the failure wins: the connection was destroyed, or the reply was longer than a reply is). Each is
 *   `SCANNER_UNAVAILABLE`: never `CLEAN`, never "skipped".
 * - **One deadline for the whole call** (Run B, Part 1, item 5 of the review of Run A2): the version, the stream and the store's body are all inside the one `timeoutMs`, and inside what the
 *   request's budget has left. A connection of its own had a timer of its own, so a slow version and a slow reply each within the time took twice the time, and a body that stopped
 *   delivering was not bounded at all (the timer destroyed the socket and the read went on waiting for a store that did not answer): the read of the body is now raced against the deadline, and the
 *   body is let go of when the scan ends without having read it to its end.
 * - **Nothing the daemon says reaches an answer.** The error carries a fixed word for the condition (`timeout`, `connection`, `error_reply`...) and never the reply, the address or the
 *   object. A failure of the *source* of the bytes (the store did not deliver them) is raised as it was: it is not the scanner's.
 * - It runs under the request's budget when there is one (`budget.effect`), so that a late answer is refused or recorded (apps/api/CLAUDE.md, "Time is bounded and enforced").
 */
export interface ClamavContentScannerOptions {
  readonly host: string;
  readonly port: number;
  /** How long one scan may take in all, from the first connection to the verdict, the store's body included; the call fails closed when it ends. */
  readonly timeoutMs: number;
  /** Opens a connection to the daemon; a test gives its own. */
  readonly connect?: (options: { readonly host: string; readonly port: number }) => Socket;
}

/** One frame of the stream. clamd accepts any frame up to its `StreamMaxLength`; 64 KiB keeps memory at one frame and the daemon's reads steady. */
const FRAME_BYTES = 64 * 1024;
/** A reply is one line; a daemon that sends more is not answering. */
const MAX_REPLY_BYTES = 1024;
/** The longest signature name or version line kept, so a daemon cannot make the record carry a document. */
const MAX_TOKEN_CHARACTERS = 200;

const SIGNATURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

type Reason =
  'connection' | 'timeout' | 'closed' | 'error_reply' | 'bad_reply' | 'early_reply' | 'bad_version';

const unavailable = (reason: Reason): ContentScannerError =>
  new ContentScannerError('SCANNER_UNAVAILABLE', `The content scanner did not answer: ${reason}`);

/** The one deadline of a scan, which every connection of the scan and the read of the store's body share. */
class Deadline {
  readonly #timer: NodeJS.Timeout;
  readonly #listeners = new Set<() => void>();
  #expired = false;

  constructor(milliseconds: number) {
    this.#timer = setTimeout(() => {
      this.#expired = true;
      for (const listener of [...this.#listeners]) listener();
    }, milliseconds);
    this.#timer.unref();
  }

  /** Calls `listener` when the deadline ends (at once if it has), and gives back what takes the listener away. */
  onExpiry(listener: () => void): () => void {
    if (this.#expired) {
      listener();
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clear(): void {
    clearTimeout(this.#timer);
    this.#listeners.clear();
  }
}

/** One connection to the daemon, ended by the deadline of the call. Its failures are the scanner's; it never rethrows what a caller's own code threw. */
class Connection {
  readonly #socket: Socket;
  readonly #unsubscribe: () => void;
  #failure: ContentScannerError | undefined;
  readonly #failed: Promise<never>;
  #rejectFailed: ((error: ContentScannerError) => void) | undefined;
  #connected = false;
  #closed = false;
  #received = Buffer.alloc(0);
  #wake: (() => void) | undefined;

  constructor(socket: Socket, deadline: Deadline) {
    this.#socket = socket;
    this.#failed = new Promise<never>((_resolve, reject) => {
      this.#rejectFailed = reject;
    });
    // Whoever does not race this promise must not be told of its rejection.
    this.#failed.catch(() => undefined);
    socket.on('connect', () => {
      this.#connected = true;
      this.#notify();
    });
    socket.on('data', (data: Buffer) => {
      this.#received = Buffer.concat([this.#received, data]);
      if (this.#received.length > MAX_REPLY_BYTES) this.#fail('bad_reply');
      this.#notify();
    });
    socket.on('error', () => {
      this.#fail('connection');
    });
    socket.on('close', () => {
      this.#closed = true;
      this.#notify();
    });
    this.#unsubscribe = deadline.onExpiry(() => {
      this.#fail('timeout');
    });
  }

  #fail(reason: Reason): void {
    if (this.#failure === undefined) {
      this.#failure = unavailable(reason);
      this.#rejectFailed?.(this.#failure);
    }
    this.#socket.destroy();
    this.#notify();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async #until(done: () => boolean): Promise<void> {
    while (!done()) {
      if (this.#failure !== undefined) throw this.#failure;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  async opened(): Promise<void> {
    await this.#until(() => this.#connected);
  }

  /** Whether the daemon has said anything yet. Before the object has been sent, nothing it says is a reply to it. */
  hasReply(): boolean {
    return this.#received.length > 0;
  }

  /** Waits for `work`, and gives up with the connection's failure if the connection fails first (the deadline, a reset, a reply too long): a body that stalls does not hold the scan past it. */
  async raceFailure<T>(work: Promise<T>): Promise<T> {
    // The work that is given up on may still fail later, and nobody is left to hear it.
    work.catch(() => undefined);
    return Promise.race([work, this.#failed]);
  }

  /** Writes and waits until the bytes have left (a slow daemon slows the caller). */
  async write(data: Buffer): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(data, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(this.#failure ?? unavailable('connection'));
      });
    });
    // The connection may have failed while the bytes were leaving: read again, not as the check above left it.
    const failed = this.#failureNow();
    if (failed !== undefined) throw failed;
  }

  /** What has gone wrong with the connection, read at this moment (a check made before an await may be out of date after it). */
  #failureNow(): ContentScannerError | undefined {
    return this.#failure;
  }

  /** The reply, without its terminator, once the daemon has ended it (or closed the connection having sent it). */
  async reply(): Promise<string> {
    await this.#until(() => this.#received.includes(0) || this.#closed);
    // A failure that was recorded wins over a reply that is present beside it: the connection was destroyed, or the reply was longer than a reply is, and what the daemon said is not
    // the verdict of a stream that was read whole.
    if (this.#failure !== undefined) throw this.#failure;
    const end = this.#received.indexOf(0);
    if (end < 0 && this.#received.length === 0) throw unavailable('closed');
    const text = this.#received.subarray(0, end < 0 ? undefined : end).toString('utf8');
    return text.replace(/[\r\n]+$/, '');
  }

  close(): void {
    this.#unsubscribe();
    this.#socket.destroy();
  }
}

export class ClamavContentScanner implements ContentScanner {
  readonly #options: ClamavContentScannerOptions;

  constructor(options: ClamavContentScannerOptions) {
    if (
      options.host === '' ||
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535 ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1
    ) {
      throw new ContentScannerError(
        'SCANNER_NOT_CONFIGURED',
        'The ClamAV scanner needs a host, a port and a timeout',
      );
    }
    this.#options = options;
  }

  #open(deadline: Deadline): Connection {
    const { host, port, connect } = this.#options;
    const socket =
      connect === undefined ? createConnection({ host, port }) : connect({ host, port });
    return new Connection(socket, deadline);
  }

  async #version(deadline: Deadline): Promise<string> {
    const connection = this.#open(deadline);
    try {
      await connection.opened();
      await connection.write(Buffer.from('zVERSION\0', 'latin1'));
      const line = await connection.reply();
      // A daemon that answers VERSION with something that is not a ClamAV version line is not the daemon this adapter was given.
      if (!line.startsWith('ClamAV ') || line.length > MAX_TOKEN_CHARACTERS) {
        throw unavailable('bad_version');
      }
      return line;
    } finally {
      connection.close();
    }
  }

  async #stream(
    object: ObjectBytes,
    deadline: Deadline,
  ): Promise<{ clean: true } | { clean: false; signature: string }> {
    const connection = this.#open(deadline);
    // The body is read by hand, so that a read that does not answer can be given up on at the deadline and the body let go of (a `for await` would wait for it).
    const body = object[Symbol.asyncIterator]();
    try {
      await connection.opened();
      await connection.write(Buffer.from('zINSTREAM\0', 'latin1'));
      for (;;) {
        const step = await connection.raceFailure(body.next());
        if (step.done === true) break;
        const chunk = step.value;
        for (let at = 0; at < chunk.byteLength; at += FRAME_BYTES) {
          const part = chunk.subarray(at, Math.min(at + FRAME_BYTES, chunk.byteLength));
          const frame = Buffer.alloc(4 + part.byteLength);
          frame.writeUInt32BE(part.byteLength, 0);
          frame.set(part, 4);
          await connection.write(frame);
        }
        // The daemon answers a stream when it ends, and says something before that only to refuse it: whatever it said is not the verdict of an object it has not been sent whole.
        if (connection.hasReply()) throw unavailable('early_reply');
      }
      if (connection.hasReply()) throw unavailable('early_reply');
      await connection.write(Buffer.alloc(4));
      const line = await connection.reply();
      if (line === 'stream: OK') return { clean: true };
      const found = /^stream: (.+) FOUND$/.exec(line);
      if (found?.[1] !== undefined) {
        const name = found[1];
        if (name.length <= MAX_TOKEN_CHARACTERS && SIGNATURE_NAME.test(name)) {
          return { clean: false, signature: name };
        }
        throw unavailable('bad_reply');
      }
      throw unavailable(line.endsWith('ERROR') ? 'error_reply' : 'bad_reply');
    } finally {
      connection.close();
      // The body is let go of when the scan ends without having read it to its end (a no-op for one that was); it is not waited for, because a stalled body does not answer.
      try {
        void Promise.resolve(body.return?.()).catch(() => undefined);
      } catch {
        // A body that cannot be let go of has nothing more to be done with.
      }
    }
  }

  async scan(object: ObjectBytes): Promise<ScanVerdict> {
    const budget = currentBudget();
    const work = async (): Promise<ScanVerdict> => {
      // One deadline for the whole call, and inside what the request's budget has left: the scan never outlives the request that asked for it.
      const left = budget === undefined ? Infinity : Math.floor(budget.remainingMilliseconds());
      const deadline = new Deadline(Math.max(1, Math.min(this.#options.timeoutMs, left)));
      try {
        const signatureVersion = await this.#version(deadline);
        const outcome = await this.#stream(object, deadline);
        return outcome.clean
          ? { verdict: 'CLEAN', scanner: 'clamav', signatureVersion }
          : {
              verdict: 'FLAGGED',
              scanner: 'clamav',
              signatureVersion,
              signature: outcome.signature,
            };
      } finally {
        deadline.clear();
      }
    };
    return budget === undefined ? work() : budget.effect('content_scanner', work);
  }
}
