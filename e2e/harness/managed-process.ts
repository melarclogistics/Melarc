import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

import { failWithCleanup } from './cleanup.ts';

export interface StartOptions {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Everything the process sees. Nothing is inherited from this process. */
  readonly env: Readonly<Record<string, string>>;
  readonly logDirectory: string;
  /** The process is ready when this URL answers with a success status. */
  readonly ready: { readonly url: string; readonly timeoutMs: number };
}

/** The most output kept in memory per stream. The files hold all of it. */
const MEMORY_LIMIT = 1_000_000;
const TAIL_CHARS = 2_000;
const POLL_MS = 100;
/** More than this many signal errors say nothing more: the first ones explain the failure. */
const MAX_SIGNAL_ERRORS = 5;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Only what the caller passes, plus what Windows needs before network code will start at all. A process
 * under test must not see this one's environment: the API refuses some variables outright and behaves
 * differently with others.
 */
function childEnvironment(env: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot;
  return { ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }), ...env };
}

/**
 * A process was asked to stop, then killed, and it still has not been seen to end. Sending a signal proves
 * nothing about the process: a process stuck where signals do not reach, or one that has become a zombie,
 * keeps its port and its database connections. The run does not go on as if it were gone.
 */
export class ProcessNotStoppedError extends Error {
  override name = 'ProcessNotStoppedError';
}

const running = new Set<ManagedProcess>();

/**
 * Every process this module started that is still running. The cleanup of a run that failed halfway. It tries
 * every process, however many fail to end, and then fails, naming those whose end it could not confirm.
 */
export async function stopAll(options: { graceMs?: number; killMs?: number } = {}): Promise<void> {
  const processes = [...running];
  const results = await Promise.allSettled(
    processes.map((process_) => process_.stop({ graceMs: 3_000, ...options })),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  );
  if (failures.length > 0) {
    throw new ProcessNotStoppedError(
      `${String(failures.length)} of ${String(processes.length)} processes could not be confirmed ended:\n${failures.join('\n')}`,
    );
  }
}

/**
 * A child process the harness owns: started with a clean environment, its output kept in files and in
 * memory, waited for until it answers, and always ended. It is never left running, by design: `stop` waits
 * for the end of the process, and `stopAll` reaches every process that is still up.
 */
export class ManagedProcess {
  private out = '';
  private err = '';
  private ended = false;
  private readonly exit: Promise<void>;
  private exitDescription = '';
  /** What Node reported when it could not signal the running process, kept for the message of a failed stop. */
  private readonly signalErrors: string[] = [];

  readonly name: string;
  private readonly child: ChildProcess;
  private readonly files: { stdout: string; stderr: string };
  private readonly streams: readonly WriteStream[];

  private constructor(
    name: string,
    child: ChildProcess,
    files: { stdout: string; stderr: string },
    streams: readonly WriteStream[],
  ) {
    this.name = name;
    this.child = child;
    this.files = files;
    this.streams = streams;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.out = (this.out + chunk.toString()).slice(-MEMORY_LIMIT);
      streams[0]?.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.err = (this.err + chunk.toString()).slice(-MEMORY_LIMIT);
      streams[1]?.write(chunk);
    });
    this.exit = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        this.ended = true;
        this.exitDescription = signal === null ? `code ${String(code)}` : `signal ${signal}`;
        running.delete(this);
        resolve();
      });
      // An `error` event is not an exit. Node emits it when the process could not be spawned (then there is no
      // pid and no `exit` will ever come), and also when a signal could not be delivered to a process that is
      // running (EPERM, for one): that process is still there, holding its port and its database connections,
      // and may exit later. Only the first is the end of the process. The listener stays for good: a second
      // `error` with nobody listening would throw, and a failed SIGTERM and a failed SIGKILL are two events.
      child.on('error', (error: Error) => {
        if (child.pid === undefined) {
          this.ended = true;
          this.exitDescription = `a failure to start: ${error.message}`;
          running.delete(this);
          resolve();
          return;
        }
        if (this.signalErrors.length < MAX_SIGNAL_ERRORS) this.signalErrors.push(error.message);
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exited(): boolean {
    return this.ended;
  }

  /** A call and not a read of `ended`: the process can end while a wait is under way, which a read would not see. */
  private hasEnded(): boolean {
    return this.ended;
  }

  logs(): { stdout: string; stderr: string } {
    return { stdout: this.out, stderr: this.err };
  }

  logFiles(): { stdout: string; stderr: string } {
    return this.files;
  }

  /** The end of what the process wrote, for an error message that has to say what went wrong. */
  private tail(): string {
    const show = (text: string) => (text === '' ? '(nothing)' : text.slice(-TAIL_CHARS).trimEnd());
    return `\n--- ${this.name} stdout ---\n${show(this.out)}\n--- ${this.name} stderr ---\n${show(this.err)}`;
  }

  static async start(options: StartOptions): Promise<ManagedProcess> {
    mkdirSync(options.logDirectory, { recursive: true });
    const files = {
      stdout: join(options.logDirectory, `${options.name}.stdout.log`),
      stderr: join(options.logDirectory, `${options.name}.stderr.log`),
    };
    const child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: childEnvironment(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const instance = new ManagedProcess(options.name, child, files, [
      createWriteStream(files.stdout, { flags: 'a' }),
      createWriteStream(files.stderr, { flags: 'a' }),
    ]);
    running.add(instance);

    const deadline = Date.now() + options.ready.timeoutMs;
    try {
      for (;;) {
        if (instance.ended) {
          throw new Error(
            `${options.name} exited before it was ready (${instance.exitDescription}).${instance.tail()}`,
          );
        }
        try {
          const response = await fetch(options.ready.url, { signal: AbortSignal.timeout(1_000) });
          if (response.ok) return instance;
        } catch {
          // Not answering yet.
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `${options.name} was not ready after ${String(options.ready.timeoutMs)} ms: ${options.ready.url} never answered.${instance.tail()}`,
          );
        }
        await sleep(POLL_MS);
      }
    } catch (error) {
      return failWithCleanup(error, () => instance.stop({ graceMs: 1_000 }));
    }
  }

  /**
   * Asks the process to stop, kills it if it has not ended by the end of the grace period, and waits a bounded
   * time more. It returns only when the process has been seen to end (its exit event), and it fails with a
   * {@link ProcessNotStoppedError} when it has not: a kill signal is not proof of an exit. A failed stop leaves
   * the process registered and its logs open, and can be asked again. (On Windows a stop request ends the process
   * at once.)
   */
  async stop(options: { graceMs?: number; killMs?: number } = {}): Promise<void> {
    const graceMs = options.graceMs ?? 8_000;
    const killMs = options.killMs ?? 5_000;
    let killDelivered = true;
    if (!this.hasEnded()) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exit, sleep(graceMs)]);
      if (!this.hasEnded()) {
        killDelivered = this.child.kill('SIGKILL');
        await Promise.race([this.exit, sleep(killMs)]);
      }
    }
    if (!this.hasEnded()) {
      throw new ProcessNotStoppedError(
        [
          `${this.name} (pid ${String(this.child.pid)}) did not end: it was asked to stop, killed after ${String(graceMs)} ms, ` +
            `and no exit was seen in the ${String(killMs)} ms after that.`,
          ...(killDelivered ? [] : ['The kill signal could not be delivered.']),
          ...(this.signalErrors.length === 0
            ? []
            : [`Node reported: ${this.signalErrors.join('; ')}.`]),
          'It may still be running with its port and its database connections open; end it by hand.',
        ].join(' '),
      );
    }
    await Promise.all(
      this.streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed) resolve();
            else
              stream.end(() => {
                resolve();
              });
          }),
      ),
    );
  }
}
