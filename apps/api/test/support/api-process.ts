import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';

const API_ROOT = resolve(import.meta.dirname, '../..');
export const MAIN = resolve(API_ROOT, 'dist/main.js');
export const OPENAPI_COMMAND = resolve(API_ROOT, 'dist/tools/generate-openapi.js');
export const CHECK_CONTRACT = resolve(API_ROOT, 'dist/tools/check-contract.js');
export const E2E_DATABASE = resolve(API_ROOT, 'dist/tools/e2e-database.js');
export const DB_BOOTSTRAP = resolve(API_ROOT, 'dist/tools/db-bootstrap.js');
export const DB_MIGRATE = resolve(API_ROOT, 'dist/tools/db-migrate.js');
export const DB_RESET = resolve(API_ROOT, 'dist/tools/db-reset.js');
export const DB_ORPHANS = resolve(API_ROOT, 'dist/tools/db-orphans.js');
/** A test-only entry point: the real application plus something that refuses to shut down. */
export const SHUTDOWN_FIXTURE = resolve(API_ROOT, 'test/support/shutdown-fixture.mjs');

const BUILT_SHUTDOWN_HANDLERS = resolve(API_ROOT, 'dist/platform/lifecycle/shutdown-handlers.js');

/**
 * A valid runtime-role URL that nothing listens on. The API requires one to start, but its pool connects
 * lazily, so a process test that is not about the database gets a configuration that is accepted and a
 * database that is absent (the API is live, and not ready). The password is a canary: no output of any
 * process may contain it. Tests that need a real database are in test/database.
 */
export const UNREACHABLE_DATABASE_URL =
  'postgres://melarc_api_runtime:ENV-SECRET-ONE@127.0.0.1:1/melarc';

/**
 * The deadlines the helpers apply to themselves, in milliseconds.
 *
 * Vitest ends a test after `testTimeout` (vitest.config.ts) with a message that says only that the test
 * timed out, and it does not stop what the test started. Every deadline here is shorter than that, and
 * so is the sum of the ones the longest test waits for in turn, so a helper fails first, says what it was
 * waiting for, and has already killed its process. api-process.test.ts holds the sum to the real timeout.
 */
export const DEADLINES = {
  /** A script that is expected to finish by itself, such as a startup refusal. */
  finish: 8_000,
  /** The API answering /readyz after it starts. */
  ready: 8_000,
  /** One /readyz request. */
  request: 1_000,
  /** A process ending after a stop signal it is expected to handle. */
  stop: 8_000,
  /** The kill itself. */
  kill: 3_000,
} as const;

/** The process tests run the built output, so a missing or stale build is a failure, never a skip. */
export function requireBuild(): void {
  for (const script of [
    MAIN,
    OPENAPI_COMMAND,
    CHECK_CONTRACT,
    E2E_DATABASE,
    DB_BOOTSTRAP,
    DB_MIGRATE,
    DB_RESET,
    DB_ORPHANS,
    BUILT_SHUTDOWN_HANDLERS,
  ]) {
    if (!existsSync(script)) {
      throw new Error(`${script} does not exist. Build first: pnpm --filter @melarc/api build`);
    }
  }
  if (!existsSync(SHUTDOWN_FIXTURE)) {
    throw new Error(
      `${SHUTDOWN_FIXTURE} does not exist: the test fixture is part of the repository.`,
    );
  }
}

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) =>
    server.close(() => {
      resolveClose();
    }),
  );
  return port;
}

/** Only what a test passes, plus what Windows needs before network code will start at all. */
function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot;
  return { ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }), ...overrides };
}

const sleep = (ms: number) =>
  new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, ms);
  });

/** The value, or `undefined` if it took longer than `ms`. The timer never outlives the call. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout(undefined);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** When the process was seen to end (Date.now()), for measuring against the times in its own log. */
  readonly endedAt: number;
}

/** Every process a test started and has not seen end, so cleanup does not depend on the test's own code. */
const live = new Set<RunningProcess>();

/** Kills, with SIGKILL, every process the helpers started that is still running. */
export async function killAll(): Promise<void> {
  await Promise.all([...live].map((running) => running.forceKill()));
}

const TAIL_CHARS = 2_000;
const tail = (text: string) => (text === '' ? '(nothing)' : text.slice(-TAIL_CHARS).trimEnd());

export class RunningProcess {
  private out = '';
  private err = '';
  private done: Finished | undefined;
  private readonly startedAt = Date.now();
  /** Why the process could not be started at all. Not set for a process that ran and then failed. */
  private startFailure: Error | undefined;
  readonly exited: Promise<Finished>;

  constructor(
    private readonly child: ChildProcess,
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly envKeys: readonly string[],
  ) {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.out += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.err += chunk.toString();
    });
    this.exited = new Promise((resolveExit, rejectExit) => {
      child.on('error', (error) => {
        // spawn() reports a process that could not be started here; kill() failures arrive here too.
        if (child.pid !== undefined) return;
        this.startFailure = new Error(
          `could not start ${this.commandLine()}: ${error.message}\n${this.report('')}`,
        );
        rejectExit(this.startFailure);
      });
      child.once('close', (code, signal) => {
        this.done = { code, signal, stdout: this.out, stderr: this.err, endedAt: Date.now() };
        live.delete(this);
        resolveExit(this.done);
      });
    });
    // The rejection belongs to whoever awaits `exited`; this only stops it being reported as unhandled
    // when a test fails before it gets that far.
    this.exited.catch(() => undefined);
    live.add(this);
  }

  get stdout(): string {
    return this.out;
  }

  get stderr(): string {
    return this.err;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private commandLine(): string {
    return [this.command, ...this.args].join(' ');
  }

  /** What a failed wait must say: the command, the time, and what the process wrote. Never the values. */
  private report(what: string): string {
    const lines = [
      what === ''
        ? undefined
        : `${what} (pid ${String(this.pid)}, after ${String(Date.now() - this.startedAt)} ms)`,
      `  command: ${this.commandLine()}`,
      `  environment keys: ${this.envKeys.join(', ') || '(none)'}`,
      `  stdout (last ${String(TAIL_CHARS)} characters):\n${tail(this.out)}`,
      `  stderr (last ${String(TAIL_CHARS)} characters):\n${tail(this.err)}`,
    ];
    return lines.filter((line) => line !== undefined).join('\n');
  }

  private describeExit(finished: Finished): string {
    return finished.signal === null
      ? `exit code ${String(finished.code)}`
      : `signal ${finished.signal}`;
  }

  /** Sends a signal and returns at once. Pair it with `waitForExit` or use `stop`. */
  signal(name: NodeJS.Signals): void {
    this.child.kill(name);
  }

  /**
   * Waits for the process to end by itself. If it does not within the deadline it is killed, and the
   * failure says what was being waited for, not what the kill left behind.
   */
  async waitForExit(deadlineMs: number, what: string): Promise<Finished> {
    const finished = await withTimeout(this.exited, deadlineMs);
    if (finished !== undefined) return finished;
    const report = this.report(what);
    await this.forceKill();
    throw new Error(report);
  }

  /**
   * Graceful shutdown verification: sends the signal and waits for the process to end on its own. A
   * process that does not is killed and the test fails saying so; this never passes a process that had
   * to be killed off as one that shut down.
   */
  stop(signal: NodeJS.Signals = 'SIGTERM', deadlineMs: number = DEADLINES.stop): Promise<Finished> {
    this.child.kill(signal);
    return this.waitForExit(
      deadlineMs,
      `did not exit within ${String(deadlineMs)} ms of ${signal}`,
    );
  }

  /** Test cleanup, not shutdown verification: SIGKILL, which no process can handle or ignore. */
  async forceKill(): Promise<void> {
    if (this.done !== undefined || this.startFailure !== undefined) return;
    this.child.kill('SIGKILL');
    await withTimeout(
      this.exited.catch(() => undefined),
      DEADLINES.kill,
    );
  }

  /**
   * Polls until the readiness probe answers 200. Each request has its own deadline, so a server that
   * accepts the connection and never answers cannot hold the wait past its own deadline. Fails with the
   * process output if the process cannot be started, exits first, or is not ready in time.
   */
  waitUntilReady(baseUrl: string, deadlineMs: number = DEADLINES.ready): Promise<void> {
    return this.waitUntilAnswers('/readyz', 'ready', baseUrl, deadlineMs);
  }

  /**
   * The same wait for the liveness probe: the process answers, whether or not its dependencies do. For a
   * test that boots the API without the database it would need to be ready. A test about readiness or
   * draining must not use this, and must assert the readiness response itself.
   */
  waitUntilLive(baseUrl: string, deadlineMs: number = DEADLINES.ready): Promise<void> {
    return this.waitUntilAnswers('/livez', 'live', baseUrl, deadlineMs);
  }

  private async waitUntilAnswers(
    probe: '/livez' | '/readyz',
    state: 'live' | 'ready',
    baseUrl: string,
    deadlineMs: number,
  ): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (this.startFailure !== undefined) throw this.startFailure;
      if (this.done !== undefined) {
        throw new Error(
          `the process exited before it was ${state} (${this.describeExit(this.done)}):\n${this.report('')}`,
        );
      }
      try {
        const response = await fetch(`${baseUrl}${probe}`, {
          signal: AbortSignal.timeout(DEADLINES.request),
        });
        await response.text();
        if (response.status === 200) return;
      } catch {
        // not listening yet, or this request ran out of time
      }
      await sleep(100);
    }
    const report = this.report(`the process was not ${state} within ${String(deadlineMs)} ms`);
    await this.forceKill();
    throw new Error(report);
  }
}

export function startCommand(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): RunningProcess {
  const child = spawn(command, [...args], {
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new RunningProcess(child, command, args, Object.keys(env));
}

export function start(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
): RunningProcess {
  return startCommand(process.execPath, [script, ...args], env);
}

/** Runs a script that is expected to finish by itself, and fails clearly, killing it, if it does not. */
export function run(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
  deadlineMs: number = DEADLINES.finish,
): Promise<Finished> {
  return start(script, env, args).waitForExit(
    deadlineMs,
    `did not finish within ${String(deadlineMs)} ms`,
  );
}
