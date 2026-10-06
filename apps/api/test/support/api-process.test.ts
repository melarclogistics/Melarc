import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import vitestConfig from '../../vitest.config.js';
import { DEADLINES, freePort, killAll, run, start, startCommand } from './api-process.js';

const scratch: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await killAll();
  for (const server of servers.splice(0)) server.close();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A script that stays alive until it is killed. */
function script(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'melarc-harness-'));
  scratch.push(directory);
  const path = join(directory, 'script.mjs');
  writeFileSync(path, source);
  return path;
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const FOREVER = 'setInterval(() => {}, 1000); console.log("started"); console.error("noise");';

describe('the process helpers', () => {
  // Break caught: a helper deadline that is longer than the test's own, so Vitest ends the test first
  // with "timed out", which says nothing about what was being waited for, and leaves the process behind.
  it('finish inside Vitest’s test timeout even when the longest test uses them all', () => {
    const testTimeout = vitestConfig.test?.testTimeout;
    expect(testTimeout).toBeTypeOf('number');
    const longestTest = DEADLINES.ready + DEADLINES.request + DEADLINES.stop;
    expect(longestTest).toBeLessThan((testTimeout ?? 0) - 2_000);
    expect(DEADLINES.finish).toBeLessThan((testTimeout ?? 0) - 2_000);
  });

  // Break caught: a script that never finishes being reported by its exit status after it was killed
  // (a null code, or the code of the kill), which reads as a failed expectation about the program and
  // sends the investigation the wrong way.
  it('say that a script did not finish, with the command, the time and what it wrote', async () => {
    const path = script(FOREVER);

    const failure = await run(path, { SECRET_TOKEN: 'value-must-not-appear' }, [], 600).catch(
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('did not finish within 600 ms');
    expect(message).toContain(path);
    expect(message).toMatch(/after \d+ ms/);
    expect(message).toContain('started');
    expect(message).toContain('noise');
    expect(message).toContain('SECRET_TOKEN');
    expect(message).not.toContain('value-must-not-appear');
  });

  // Break caught: a timed-out run leaving its process behind, running, after the test has failed.
  it('kill the process of a script that did not finish', async () => {
    const path = script(FOREVER);
    const running = start(path, {});
    const pid = running.pid;
    expect(isAlive(pid)).toBe(true);

    await running.waitForExit(300, 'did not finish').catch(() => undefined);

    expect(isAlive(pid)).toBe(false);
  });

  // Break caught: a child that cannot be started (a missing executable) leaving every wait hanging
  // until its deadline, with an exit result that says nothing about the real cause.
  it('fail at once, naming the command, when the process cannot be started', async () => {
    const running = startCommand('melarc-no-such-executable', ['--flag'], {});

    const startedAt = Date.now();
    const exited = await running.exited.catch((error: unknown) => error as Error);
    const ready = await running
      .waitUntilReady('http://127.0.0.1:9', 5_000)
      .catch((error: unknown) => error as Error);

    expect(exited).toBeInstanceOf(Error);
    expect((exited as Error).message).toContain('could not start');
    expect((exited as Error).message).toContain('melarc-no-such-executable');
    expect((ready as Error).message).toContain('could not start');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  // Break caught: a readiness probe that waits for ever on a server that accepts the connection and
  // never answers, because the request had no deadline of its own.
  it('bound each readiness request, so a server that never answers fails at the deadline', async () => {
    const port = await freePort();
    const silent = createServer(() => undefined);
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    const running = start(script(FOREVER), {});

    const startedAt = Date.now();
    const failure = await running
      .waitUntilReady(`http://127.0.0.1:${String(port)}`, 1_500)
      .catch((error: unknown) => error as Error);
    const elapsed = Date.now() - startedAt;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('was not ready within 1500 ms');
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(1_500 + DEADLINES.request + 1_500);
  });

  // Break caught: a process that exits before it is ready being reported as a readiness timeout, which
  // would hide the output that explains the crash.
  it('report a process that exits before it is ready, with what it wrote', async () => {
    const running = start(script('console.error("boom: could not bind"); process.exit(3);'), {});

    const failure = await running
      .waitUntilReady('http://127.0.0.1:9', 5_000)
      .catch((error: unknown) => error as Error);

    expect((failure as Error).message).toContain('exited before it was ready');
    expect((failure as Error).message).toContain('code 3');
    expect((failure as Error).message).toContain('boom: could not bind');
  });

  // Break caught: a liveness wait that insists on readiness, which a process whose database is down (or
  // not wanted in the test) can never give, or one that answers 200 to either probe, which would let a
  // test that needs readiness pass without it.
  it('wait for liveness without readiness, and still wait for readiness separately', async () => {
    const port = await freePort();
    const server = createHttpServer((request, response) => {
      response.statusCode = request.url === '/livez' ? 200 : 503;
      response.end('{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const running = start(script(FOREVER), {});

    await expect(running.waitUntilLive(baseUrl, 3_000)).resolves.toBeUndefined();
    const failure = await running
      .waitUntilReady(baseUrl, 600)
      .catch((error: unknown) => error as Error);

    expect((failure as Error).message).toContain('was not ready within 600 ms');
  });

  // Break caught: a process that exits before it is live being reported as a timeout, hiding the output
  // that explains the crash.
  it('report a process that exits before it is live, with what it wrote', async () => {
    const running = start(script('console.error("boom: bad config"); process.exit(4);'), {});

    const failure = await running
      .waitUntilLive('http://127.0.0.1:9', 5_000)
      .catch((error: unknown) => error as Error);

    expect((failure as Error).message).toContain('exited before it was live');
    expect((failure as Error).message).toContain('code 4');
    expect((failure as Error).message).toContain('boom: bad config');
  });

  // Break caught: forced cleanup that asks politely (SIGTERM), so a process that handles the signal, or
  // is stuck in its own shutdown, survives the test that started it. POSIX only: Windows has no way to
  // deliver SIGTERM to a child, and kills it outright, so there is nothing to prove there.
  it.skipIf(process.platform === 'win32')(
    'kill a process that ignores SIGTERM when the test is over',
    async () => {
      const running = start(script(`process.on('SIGTERM', () => {}); ${FOREVER}`), {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pid = running.pid;
      expect(isAlive(pid)).toBe(true);

      await killAll();

      expect(isAlive(pid)).toBe(false);
    },
  );

  // Break caught: graceful-shutdown verification and forced cleanup being the same call, so a process
  // that cannot shut down is killed quietly and the test goes on to assert about a clean exit.
  it.skipIf(process.platform === 'win32')(
    'fail the graceful stop, saying so, for a process that ignores SIGTERM',
    async () => {
      const running = start(script(`process.on('SIGTERM', () => {}); ${FOREVER}`), {});
      await new Promise((resolve) => setTimeout(resolve, 300));

      const failure = await running.stop('SIGTERM', 400).catch((error: unknown) => error as Error);

      expect((failure as Error).message).toContain('did not exit within 400 ms of SIGTERM');
      expect(isAlive(running.pid)).toBe(false);
    },
  );

  // Break caught: a process that ends by itself after a stop signal being reported as a failure.
  it.skipIf(process.platform === 'win32')(
    'return the exit result of a process that stops by itself',
    async () => {
      const running = start(
        script(
          'process.on("SIGTERM", () => { console.log("bye"); process.exit(0); }); setInterval(() => {}, 1000); console.log("up");',
        ),
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      const finished = await running.stop('SIGTERM', 3_000);

      expect(finished.code).toBe(0);
      expect(finished.stdout).toContain('bye');
    },
  );
});
