import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedProcess, ProcessNotStoppedError, stopAll } from './managed-process.ts';
import { freePort } from './ports.ts';

let directory = '';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'melarc-harness-'));
});

afterEach(async () => {
  await stopAll();
  rmSync(directory, { recursive: true, force: true });
});

/** A script a test process runs: a small HTTP server that answers on PORT and says what it was given. */
function script(name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, body);
  return path;
}

const SERVER = `
import { createServer } from 'node:http';
console.log('listening-marker');
console.error('stderr-marker');
createServer((request, response) => {
  response.end(JSON.stringify({ secret: process.env.HARNESS_PARENT_SECRET ?? null, given: process.env.GIVEN ?? null }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(true);
    });
    probe.once('listening', () => {
      probe.close(() => {
        resolve(false);
      });
    });
    probe.listen(port, '127.0.0.1');
  });
}

function options(file: string, port: number, extra: Record<string, string> = {}) {
  return {
    name: 'fixture',
    command: process.execPath,
    args: [file],
    env: { PORT: String(port), ...extra },
    logDirectory: join(directory, 'logs'),
    ready: { url: `http://127.0.0.1:${String(port)}/`, timeoutMs: 10_000 },
  };
}

describe('freePort', () => {
  // Break caught: a "free" port that something already listens on, which would make a second stack fail to
  // start in a way that looks like the first one's fault.
  it('returns a port nothing is listening on, and not the same one while it is in use', async () => {
    const port = await freePort();

    expect(await isListening(port)).toBe(false);

    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      expect(await freePort()).not.toBe(port);
    } finally {
      await new Promise<void>((resolve) =>
        holder.close(() => {
          resolve();
        }),
      );
    }
  });
});

describe('a process that starts and becomes ready', () => {
  // Break caught: "started" being reported before the process can answer, which turns the first request of a
  // test into a connection error that has nothing to do with the test.
  it('is returned only once its readiness URL answers', async () => {
    const port = await freePort();

    const process_ = await ManagedProcess.start(options(script('server.mjs', SERVER), port));

    expect((await fetch(`http://127.0.0.1:${String(port)}/`)).ok).toBe(true);
    expect(process_.exited).toBe(false);
  });

  // Break caught: the host environment leaking into a process under test. The API refuses to start with some
  // variables present and behaves differently with others, so a process gets what it is given and nothing else.
  it('receives the environment it was given and nothing from the parent', async () => {
    process.env.HARNESS_PARENT_SECRET = 'parent-only-value';
    try {
      const port = await freePort();
      await ManagedProcess.start(options(script('server.mjs', SERVER), port, { GIVEN: 'yes' }));

      const seen = (await (await fetch(`http://127.0.0.1:${String(port)}/`)).json()) as {
        secret: string | null;
        given: string | null;
      };

      expect(seen).toEqual({ secret: null, given: 'yes' });
    } finally {
      delete process.env.HARNESS_PARENT_SECRET;
    }
  });

  // Break caught: output that is lost. A failing run is read from these logs, so both streams are kept, in
  // files a person can open, and in memory for the test to look at.
  it('keeps what it writes to each stream, in files and in memory', async () => {
    const port = await freePort();
    const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));
    await started.stop();

    expect(started.logs().stdout).toContain('listening-marker');
    expect(started.logs().stderr).toContain('stderr-marker');
    expect(readFileSync(started.logFiles().stdout, 'utf8')).toContain('listening-marker');
    expect(readFileSync(started.logFiles().stderr, 'utf8')).toContain('stderr-marker');
  });
});

describe('a process that does not become ready', () => {
  // Break caught: a crash at start being reported as a timeout, or not at all. The failure says that the
  // process exited, with its code, and shows the end of what it wrote.
  it('fails at once, with its exit code and its last output, when it exits first', async () => {
    const port = await freePort();
    const file = script(
      'crash.mjs',
      "console.error('boom: configuration is invalid'); process.exit(3);",
    );

    await expect(ManagedProcess.start(options(file, port))).rejects.toThrow(
      /exited before it was ready \(code 3\)[\s\S]*boom: configuration is invalid/,
    );
  });

  // Break caught (audit F07): a start that failed, and whose process could not be confirmed ended, reporting
  // only the first failure. What could not be ended is what the next run trips over, so it is reported next to
  // the reason the start failed. The process here really exits; only the confirmation is made to fail, after
  // the real stop has run, so that nothing is left open.
  it('reports a process it could not confirm ended, next to the reason the start failed', async () => {
    const port = await freePort();
    const file = script(
      'crash-and-stick.mjs',
      "console.error('boom: configuration is invalid'); process.exit(3);",
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own instance below; the spy replaces it only for one call
    const realStop = ManagedProcess.prototype.stop;
    const stop = vi.spyOn(ManagedProcess.prototype, 'stop').mockImplementationOnce(async function (
      this: ManagedProcess,
      ...args
    ) {
      await realStop.apply(this, args);
      throw new ProcessNotStoppedError('fixture (pid 4242) did not end');
    });
    try {
      const failure = await ManagedProcess.start(options(file, port)).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/exited before it was ready \(code 3\)/);
      expect((failure as Error).message).toContain('fixture (pid 4242) did not end');
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      stop.mockRestore();
    }
  });

  // Break caught (audit B-01): a command that cannot be started being reported as a timeout, or hanging. Node
  // emits `error` and never `exit` for a failed spawn, so the error is the only evidence the process is not coming.
  // This is the one case where an `error` event does mean the process is not running.
  it('fails at once, naming the operating system error, when the command cannot be started', async () => {
    const port = await freePort();

    const failure = await ManagedProcess.start({
      ...options('unused', port),
      command: 'melarc-no-such-command-for-the-harness',
      ready: { url: `http://127.0.0.1:${String(port)}/`, timeoutMs: 5_000 },
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /exited before it was ready \(a failure to start: .*ENOENT/,
    );
    await expect(stopAll()).resolves.toBeUndefined();
  });

  // Break caught: "ready" being decided by an answer of any kind. A server that is up and answering 503 has not
  // finished starting (a readiness probe says so), and treating it as ready sends the first test into it.
  // The process here listens the whole time, so what is left running afterwards is what proves it was stopped:
  // nothing calls stopAll first.
  it('is not ready while it answers with an error status, and is stopped when the deadline passes', async () => {
    const port = await freePort();
    const file = script(
      'unready.mjs',
      "import { createServer } from 'node:http';\ncreateServer((request, response) => { response.statusCode = 503; response.end('starting'); }).listen(Number(process.env.PORT), '127.0.0.1');",
    );

    await expect(
      ManagedProcess.start({
        ...options(file, port),
        ready: { url: `http://127.0.0.1:${String(port)}/`, timeoutMs: 700 },
      }),
    ).rejects.toThrow(/not ready after 700 ms/);

    expect(await isListening(port)).toBe(false);
  });

  // Break caught: a hung start leaving a process running after the run has failed. The deadline ends the
  // wait, kills the process, and says what it was waiting for.
  it('fails at the deadline, naming what it waited for', async () => {
    const port = await freePort();
    const file = script('hang.mjs', 'setInterval(() => {}, 1000);');

    await expect(
      ManagedProcess.start({
        ...options(file, port),
        ready: { url: `http://127.0.0.1:${String(port)}/`, timeoutMs: 600 },
      }),
    ).rejects.toThrow(
      new RegExp(`not ready after 600 ms[\\s\\S]*http://127.0.0.1:${String(port)}/`),
    );
  });
});

describe('stopping', () => {
  // Break caught: a stop that returns before the process is gone, so the next step (dropping its database)
  // races a process that still holds connections.
  it('returns only after the process has ended, and frees its port', async () => {
    const port = await freePort();
    const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));

    await started.stop();

    expect(started.exited).toBe(true);
    expect(await isListening(port)).toBe(false);
  });

  it('is safe to ask twice', async () => {
    const port = await freePort();
    const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));

    await started.stop();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  // Break caught: a process that will not stop on request being left to run on, which is how a machine
  // collects servers. After a short grace it is killed. POSIX only, and skipped explicitly there is no other
  // choice: Windows cannot trap SIGTERM, so a stop request always ends the process at once and the
  // escalation to SIGKILL cannot be reached. This is not counted as a pass on Windows.
  it.skipIf(process.platform === 'win32')(
    'kills a process that does not stop when asked',
    async () => {
      const port = await freePort();
      const file = script(
        'stubborn.mjs',
        `
import { createServer } from 'node:http';
process.on('SIGTERM', () => {});
createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`,
      );
      const started = await ManagedProcess.start(options(file, port));

      await started.stop({ graceMs: 300 });

      expect(started.exited).toBe(true);
      expect(await isListening(port)).toBe(false);
    },
  );

  // Break caught: a process that cannot be ended being reported as ended. The kill signal is not proof of
  // anything. The escalation is bounded, and when the process is still running at the end of it, stop says so,
  // names the process, and does not claim it is gone. (A process that will not die is modelled by a child whose
  // kill has no effect: the signal is sent, and nothing exits.)
  describe('a process that cannot be confirmed ended (audit F07)', () => {
    /** Makes the signals do nothing, as for a process stuck where signals do not reach. Returns the undo. */
    function ignoreSignals(started: ManagedProcess, delivered = true): () => void {
      const child = (started as unknown as { child: ChildProcess }).child;
      const real = child.kill.bind(child);
      child.kill = () => delivered;
      return () => {
        child.kill = real;
      };
    }

    it('fails, naming the process, when it is still running after the bounded escalation', async () => {
      const port = await freePort();
      const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));
      const restore = ignoreSignals(started);
      try {
        const error = await started.stop({ graceMs: 50, killMs: 100 }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProcessNotStoppedError);
        expect((error as Error).message).toContain('fixture');
        expect((error as Error).message).toContain(String(started.pid));
        expect((error as Error).message).toMatch(/did not end/);
        expect(started.exited).toBe(false);
        expect(await isListening(port)).toBe(true);
      } finally {
        restore();
        await started.stop();
      }
    });

    it('says when the kill signal could not even be delivered', async () => {
      const port = await freePort();
      const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));
      const restore = ignoreSignals(started, false);
      try {
        await expect(started.stop({ graceMs: 50, killMs: 100 })).rejects.toThrow(
          /could not be delivered/,
        );
      } finally {
        restore();
        await started.stop();
      }
    });

    // Break caught: a failed stop that cannot be retried, or that ends the log streams under a process that is
    // still writing to them (a write after the end is an unhandled error).
    it('can be asked again once the process can be ended, and keeps its logs open meanwhile', async () => {
      const port = await freePort();
      const file = script(
        'ticker.mjs',
        `
import { createServer } from 'node:http';
setInterval(() => console.log('tick'), 40);
createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`,
      );
      const started = await ManagedProcess.start(options(file, port));
      const restore = ignoreSignals(started);

      await expect(started.stop({ graceMs: 50, killMs: 100 })).rejects.toBeInstanceOf(
        ProcessNotStoppedError,
      );
      const before = readFileSync(started.logFiles().stdout, 'utf8').length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = readFileSync(started.logFiles().stdout, 'utf8').length;
      expect(after).toBeGreaterThan(before);

      restore();
      await started.stop();
      expect(started.exited).toBe(true);
      expect(await isListening(port)).toBe(false);
    });

    // Break caught: a cleanup that gives up on the first process it cannot stop, leaving the rest running.
    it('stopAll tries every process and names the ones it could not confirm ended', async () => {
      const first = await freePort();
      const second = await freePort();
      const stubborn = await ManagedProcess.start(options(script('one.mjs', SERVER), first));
      await ManagedProcess.start({ ...options(script('two.mjs', SERVER), second), name: 'second' });
      const restore = ignoreSignals(stubborn);
      try {
        const error = await stopAll({ graceMs: 50, killMs: 100 }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('fixture');
        expect((error as Error).message).not.toContain('second');
        expect(await isListening(second)).toBe(false);
        expect(await isListening(first)).toBe(true);
      } finally {
        restore();
        await stopAll();
      }
    });
  });

  // Break caught (audit B-01): an `error` event from a process that is running being taken for its exit. Node
  // emits `error` when it cannot signal a child (the case it names is EPERM), returns false, and emits no `exit`:
  // the child is still there, holding its port and its database connections. A stop that resolves here is a
  // teardown that lies. These tests use a real child and Node's own `emit`, as Node itself does in `kill()`.
  describe('an error event from a process that is still running (audit B-01)', () => {
    const signalError = (): Error =>
      Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill', errno: -1 });

    /**
     * Makes every signal fail the way Node reports a failed signal: an `error` event, a false return, no exit.
     * Returns the undo and the number of signals attempted.
     */
    function failSignals(started: ManagedProcess): { restore: () => void; attempts: () => number } {
      const child = (started as unknown as { child: ChildProcess }).child;
      const real = child.kill.bind(child);
      let attempts = 0;
      child.kill = () => {
        attempts += 1;
        child.emit('error', signalError());
        return false;
      };
      return {
        restore: () => {
          child.kill = real;
        },
        attempts: () => attempts,
      };
    }

    it('is not taken for an exit: stop fails, names the signal error, and the process is still tracked', async () => {
      const port = await freePort();
      const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));
      const signals = failSignals(started);
      try {
        const error = await started.stop({ graceMs: 50, killMs: 100 }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProcessNotStoppedError);
        expect((error as Error).message).toMatch(/did not end/);
        expect((error as Error).message).toContain('kill EPERM');
        expect(signals.attempts()).toBe(2);
        expect(started.exited).toBe(false);
        expect(await isListening(port)).toBe(true);
        // Still the harness's to end: the cleanup of a failed run reaches it.
        const all = await stopAll({ graceMs: 50, killMs: 100 }).catch((e: unknown) => e);
        expect(all).toBeInstanceOf(ProcessNotStoppedError);
        expect((all as Error).message).toContain('fixture');
      } finally {
        signals.restore();
        await started.stop();
      }
      expect(started.exited).toBe(true);
      expect(await isListening(port)).toBe(false);
    });

    // Break caught: a second error from the same child crashing the harness (an `error` event with no listener
    // throws), which is what a one-time listener does on the second failed signal.
    it('can happen more than once without bringing the harness down', async () => {
      const port = await freePort();
      const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));
      const child = (started as unknown as { child: ChildProcess }).child;

      expect(() => {
        child.emit('error', signalError());
        child.emit('error', signalError());
        child.emit('error', signalError());
      }).not.toThrow();

      expect(started.exited).toBe(false);
      await started.stop();
      expect(started.exited).toBe(true);
    });

    // Break caught: an error that arrives before the real exit hiding that exit. The exit that follows is the
    // evidence the process is gone, and it is recognized however many errors came first.
    it('does not hide the exit that really follows', async () => {
      const port = await freePort();
      const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));
      const child = (started as unknown as { child: ChildProcess }).child;
      child.emit('error', signalError());
      expect(started.exited).toBe(false);

      await started.stop();

      expect(started.exited).toBe(true);
      expect(await isListening(port)).toBe(false);
      await expect(stopAll()).resolves.toBeUndefined();
    });

    // Break caught: a late error, after the process has ended, undoing or contradicting the truth.
    it('is ignored once the process has ended', async () => {
      const port = await freePort();
      const started = await ManagedProcess.start(options(script('server.mjs', SERVER), port));
      const child = (started as unknown as { child: ChildProcess }).child;
      await started.stop();

      expect(() => child.emit('error', signalError())).not.toThrow();

      expect(started.exited).toBe(true);
      await expect(started.stop()).resolves.toBeUndefined();
    });

    // Break caught: stopAll counting a process whose signals failed as ended, or giving up on the rest.
    it('stopAll names the process whose signals failed and still ends the others', async () => {
      const first = await freePort();
      const second = await freePort();
      const stubborn = await ManagedProcess.start(options(script('one.mjs', SERVER), first));
      await ManagedProcess.start({ ...options(script('two.mjs', SERVER), second), name: 'second' });
      const signals = failSignals(stubborn);
      try {
        const error = await stopAll({ graceMs: 50, killMs: 100 }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProcessNotStoppedError);
        expect((error as Error).message).toMatch(/1 of 2 processes could not be confirmed ended/);
        expect((error as Error).message).toContain('fixture');
        expect((error as Error).message).not.toContain('second');
        expect(await isListening(first)).toBe(true);
        expect(await isListening(second)).toBe(false);
      } finally {
        signals.restore();
        await stopAll();
      }
      expect(await isListening(first)).toBe(false);
    });
  });

  // Break caught: processes started by a run that failed halfway being missed by the cleanup.
  it('stopAll ends every process that was started and is still running', async () => {
    const first = await freePort();
    const second = await freePort();
    await ManagedProcess.start(options(script('one.mjs', SERVER), first));
    await ManagedProcess.start({ ...options(script('two.mjs', SERVER), second), name: 'second' });

    await stopAll();

    expect(await isListening(first)).toBe(false);
    expect(await isListening(second)).toBe(false);
  });
});
