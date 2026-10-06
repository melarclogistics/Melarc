import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import type { ShutdownOutcome } from './graceful-shutdown.js';
import { installShutdownHandlers, type ShutdownTarget } from './shutdown-handlers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(shutdown: () => Promise<ShutdownOutcome>, lingerMs: number) {
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
  const logs = new CapturedLogs();
  installShutdownHandlers({ logger: logs.logger, target, shutdown, lingerMs });
  return { listeners, calls, logs };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a clean shutdown that the process does not follow', () => {
  // Break caught: a process that has finished shutting down and does not end. A timer, a socket or an interval
  // that nothing registered for shutdown keeps the event loop alive, "shutdown complete" has been logged, and the
  // platform waits out its whole grace period before it kills what looks like a hung process. After a clean shutdown
  // the process is given a moment to end by itself, and ended, non-zero and loudly, when it does not.
  it('is ended, non-zero, once the moment has passed', async () => {
    const { listeners, calls, logs } = setup(() => Promise.resolve('clean'), 30);

    listeners.get('SIGTERM')?.();
    await wait(120);

    expect(calls).toEqual(['exitCode=0', 'exitCode=1', 'exit(1)']);
    expect(
      logs
        .records()
        .find((record) => record.msg === 'process still running after a clean shutdown'),
    ).toMatchObject({
      level: 'error',
    });
  });

  // Break caught: the guard keeping the process alive itself, which would turn the protection into the hang.
  it('does not keep the process alive while it waits', async () => {
    const timers: unknown[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (...args: Parameters<typeof setTimeout>) => {
        const timer = real(...args);
        timers.push(timer);
        return timer;
      },
    );
    const { listeners } = setup(() => Promise.resolve('clean'), 5000);

    listeners.get('SIGTERM')?.();
    await Promise.resolve();
    await Promise.resolve();

    const guard = timers.find(
      (timer) => (timer as { hasRef?: () => boolean }).hasRef !== undefined,
    ) as { hasRef: () => boolean; unref: () => void } | undefined;
    expect(guard?.hasRef()).toBe(false);
    guard?.unref();
  });

  // Break caught: the moment being applied to a forced shutdown, which is ended at once already.
  it('is not applied after a forced shutdown, which ends the process at once', async () => {
    const { listeners, calls } = setup(() => Promise.resolve('forced'), 30);

    listeners.get('SIGTERM')?.();
    await wait(120);

    expect(calls).toEqual(['exitCode=1', 'exit(1)']);
  });
});
