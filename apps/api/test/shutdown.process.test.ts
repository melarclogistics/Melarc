import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DEADLINES,
  freePort,
  killAll,
  requireBuild,
  SHUTDOWN_FIXTURE,
  start,
  UNREACHABLE_DATABASE_URL,
  type Finished,
} from './support/api-process.js';

beforeAll(requireBuild);
afterEach(killAll);

/** SHUTDOWN_TIMEOUT_MS has a minimum of 1000. */
const BUDGET_MS = 1_000;
/** Startup, then the budget, then margin: the longest the fixture legitimately needs to end by itself. */
const LIFETIME_MS = DEADLINES.ready + BUDGET_MS + 3_000;

/**
 * Starts the fixture: the real application, built and wired as in production, plus something a test
 * needs and production does not have (see shutdown-fixture.mjs). `clean` closes everything it opened;
 * `stalled` has a resource whose close never finishes and a handle that keeps the process alive.
 */
async function launch(mode: 'clean' | 'stalled', flags: string[], budgetMs: number) {
  const port = await freePort();
  const running = start(
    SHUTDOWN_FIXTURE,
    {
      NODE_ENV: 'production',
      APP_ENV: 'local',
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      SHUTDOWN_TIMEOUT_MS: String(budgetMs),
      SHUTDOWN_DRAIN_DELAY_MS: '0',
    },
    [mode, ...flags],
  );
  return { running, baseUrl: `http://127.0.0.1:${String(port)}` };
}

function records(finished: Finished): Record<string, unknown>[] {
  return finished.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** What every forced end must look like, however the stop signal arrived. */
function expectForcedEnd(finished: Finished): void {
  const log = records(finished);
  const messages = log.map((record) => record.msg);

  // It ended by itself, not because the test killed it, and it said so with exit code 1.
  expect(finished.signal).toBeNull();
  expect(finished.code).toBe(1);
  expect(finished.stderr).toBe('');
  expect(messages).toEqual(
    expect.arrayContaining([
      'signal received',
      'shutdown started',
      'shutdown timed out',
      'shutdown forced',
      'exiting now',
    ]),
  );
  // Nothing claims that everything was closed.
  expect(messages).not.toContain('shutdown complete');
  expect(log.find((record) => record.msg === 'shutdown forced')).toMatchObject({
    level: 'error',
    reason: 'timeout',
    stage: 'resources',
    stalled_resources: ['stalled-pool'],
    closed_resources: [],
  });
  // Within the budget, measured from when shutdown started to when the process was seen to end.
  const startedAt = Date.parse(
    String(log.find((record) => record.msg === 'shutdown started')?.time),
  );
  expect(finished.endedAt - startedAt).toBeLessThan(BUDGET_MS + 2_500);
}

describe('a real process whose cleanup stalls', () => {
  // Break caught: a process that, after a stalled cleanup, only sets an exit code. Its open handle keeps
  // the event loop alive, so it would sit there until the platform killed it, with no exit code at all.
  // The fixture signals itself, so this runs on Windows as well: process.emit reaches the same handlers.
  it('ends itself with exit code 1 within the budget, though a handle stays open', async () => {
    const { running } = await launch('stalled', ['--signal-itself'], BUDGET_MS);

    const finished = await running.waitForExit(LIFETIME_MS, 'did not end by itself');

    expectForcedEnd(finished);
  });

  // Break caught: the same, through a real signal from the operating system. Windows cannot deliver a
  // graceful SIGTERM to a child process (it ends the child outright), so this runs on Linux and macOS
  // (and CI) and is reported as skipped, not passed, on Windows.
  it.skipIf(process.platform === 'win32')(
    'ends itself with exit code 1 within the budget after a real SIGTERM',
    async () => {
      const { running, baseUrl } = await launch('stalled', [], BUDGET_MS);
      await running.waitUntilLive(baseUrl);

      running.signal('SIGTERM');
      const finished = await running.waitForExit(
        BUDGET_MS + 3_000,
        'did not end by itself after SIGTERM',
      );

      expectForcedEnd(finished);
    },
  );
});

describe('a real process that shuts down cleanly', () => {
  // Break caught: the forced path taken always, so every shutdown is cut short and reported non-zero. The
  // same fixture with a resource that does close must end on its own, with exit code 0.
  it('ends by itself with exit code 0, and says it completed', async () => {
    const { running } = await launch('clean', ['--signal-itself'], 5_000);

    const finished = await running.waitForExit(LIFETIME_MS, 'did not end by itself');

    expect(finished).toMatchObject({ code: 0, signal: null, stderr: '' });
    const messages = records(finished).map((record) => record.msg);
    expect(messages).toEqual(
      expect.arrayContaining(['signal received', 'shutdown started', 'shutdown complete']),
    );
    expect(messages).not.toContain('exiting now');
    expect(messages).not.toContain('shutdown forced');
  });

  // Break caught: a request already in flight when the stop signal arrives being cut off, or the process
  // ending before it was answered. The route signals the process on arrival and answers 400 ms later.
  it('lets a request that was in flight when the signal arrived finish, then exits 0', async () => {
    const { running, baseUrl } = await launch('clean', ['--slow-route'], 5_000);
    await running.waitUntilLive(baseUrl);

    // The body is read before waiting for the process: the request's deadline covers reading it too.
    const response = await fetch(`${baseUrl}/api/v1/fixture/slow`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body: unknown = await response.json();
    const finished = await running.waitForExit(5_000, 'did not end by itself after the request');

    expect(response.status).toBe(200);
    expect(body).toEqual({ finished: true });
    expect(finished).toMatchObject({ code: 0, signal: null });
    const messages = records(finished).map((record) => record.msg);
    expect(messages.indexOf('signal received')).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf('signal received')).toBeLessThan(messages.indexOf('shutdown complete'));
  });
});
