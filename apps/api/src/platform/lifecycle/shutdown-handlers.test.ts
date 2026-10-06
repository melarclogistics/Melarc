import { describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import type { ShutdownOutcome } from './graceful-shutdown.js';
import { installShutdownHandlers, type ShutdownTarget } from './shutdown-handlers.js';

/** A process that records what it is told to do, in order, instead of doing it. */
function fakeProcess() {
  const listeners = new Map<string, () => void>();
  const calls: string[] = [];
  const target: ShutdownTarget = {
    on: (signal, listener) => {
      listeners.set(signal, listener);
    },
    setExitCode: (code) => {
      calls.push(`exitCode=${String(code)}`);
    },
    exit: (code) => {
      calls.push(`exit(${String(code)})`);
    },
  };
  return { target, listeners, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function install(shutdown: () => Promise<ShutdownOutcome>) {
  const logs = new CapturedLogs();
  const process = fakeProcess();
  installShutdownHandlers({ logger: logs.logger, target: process.target, shutdown });
  return { logs, ...process };
}

describe('installShutdownHandlers', () => {
  // Break caught: a stop signal nobody listens for, so the platform's SIGTERM kills the process
  // without any shutdown at all.
  it('stops on both SIGINT and SIGTERM', () => {
    const { listeners } = install(() => Promise.resolve('clean'));
    expect([...listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  // Break caught: ending the process by force after a clean shutdown, which cuts buffered output and
  // skips the handles the event loop would have closed itself.
  it('sets exit code 0 after a clean shutdown and leaves the process to end by itself', async () => {
    const { listeners, calls, logs } = install(() => Promise.resolve('clean'));

    listeners.get('SIGTERM')?.();
    await settle();

    expect(calls).toEqual(['exitCode=0']);
    expect(logs.records().find((record) => record.msg === 'signal received')).toMatchObject({
      signal: 'SIGTERM',
    });
  });

  // Break caught: setting only the exit code after a forced shutdown. An exit code cannot stop a handle
  // that is still open, so the process would sit there until the supervisor killed it.
  it('ends the process at once, non-zero, after a forced shutdown, having logged it first', async () => {
    const { target, listeners, calls, logs } = install(() => Promise.resolve('forced'));
    const loggedBeforeExit: string[] = [];
    target.exit = (code) => {
      loggedBeforeExit.push(...logs.records().map((record) => String(record.msg)));
      calls.push(`exit(${String(code)})`);
    };

    listeners.get('SIGINT')?.();
    await settle();

    expect(calls).toEqual(['exitCode=1', 'exit(1)']);
    expect(loggedBeforeExit).toContain('exiting now');
    expect(logs.records().find((record) => record.msg === 'exiting now')).toMatchObject({
      level: 'error',
      exit_code: 1,
    });
  });

  // Break caught: a shutdown that itself blows up leaving the process running half-stopped, or its
  // error text (which can carry a credential) written unredacted.
  it('ends the process non-zero if the shutdown itself fails, without leaking the error', async () => {
    const { listeners, calls, logs } = install(() =>
      Promise.reject(new Error('boom: postgres://melarc:hunter2@db.internal/melarc')),
    );

    listeners.get('SIGTERM')?.();
    await settle();

    expect(calls).toEqual(['exitCode=1', 'exit(1)']);
    expect(logs.records().find((record) => record.msg === 'shutdown crashed')).toMatchObject({
      level: 'fatal',
    });
    expect(logs.text()).not.toContain('hunter2');
  });

  // Break caught: a second signal (an impatient operator, or the platform repeating itself) starting a
  // second shutdown on top of the first.
  it('runs one shutdown however many signals arrive', async () => {
    const shutdown = vi.fn(() => Promise.resolve<ShutdownOutcome>('clean'));
    const { listeners } = install(shutdown);

    listeners.get('SIGTERM')?.();
    listeners.get('SIGTERM')?.();
    listeners.get('SIGINT')?.();
    await settle();

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
