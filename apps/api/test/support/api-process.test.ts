import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import vitestConfig from '../../vitest.config.js';
import {
  apiSettings,
  DEADLINES,
  freePort,
  killAll,
  MAIN,
  run,
  start,
  startCommand,
} from './api-process.js';

const scratch: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await killAll();
  for (const server of servers.splice(0)) server.close();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A project of the API's test configuration, as vitest.config.ts declares it. */
interface DeclaredProject {
  readonly test: {
    readonly name: string;
    readonly testTimeout?: number;
    readonly hookTimeout?: number;
  };
}

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
  // with "timed out", which says nothing about what was being waited for, and leaves the process behind;
  // and (27 October 2026) a project whose tests start processes left at a limit the waits do not fit.
  it('finish inside Vitest’s limits, test and hook, of every project that starts processes, even when the longest test uses them all', () => {
    const declared = (vitestConfig.test?.projects ?? []) as unknown as readonly DeclaredProject[];
    // The longest is the SIGTERM test: the API comes up, says it has taken the signal, answers one request and ends.
    const longestTest = DEADLINES.ready + DEADLINES.stop + DEADLINES.request + DEADLINES.stop;
    for (const name of ['process', 'database', 'database-alone']) {
      const own = declared.find((entry) => entry.test.name === name)?.test;
      for (const limit of [own?.testTimeout, own?.hookTimeout]) {
        expect(limit, name).toBeTypeOf('number');
        expect(longestTest, name).toBeLessThan((limit ?? 0) - 2_000);
        expect(DEADLINES.finish, name).toBeLessThan((limit ?? 0) - 2_000);
      }
    }
  });

  // The owner's decision of 27 October 2026 (SLICE-000 plan, 7.48): a process may take 20 seconds to start or to finish before a helper
  // gives up, about four times the slowest seen on an idle workstation, because a busy one missed 8. These are guards against a hang and
  // not a measure of speed. Break caught: a wait raised again to get a test green, which is the owner's decision and not a fix.
  it('wait as long as the owner decided, and no longer', () => {
    expect(DEADLINES).toEqual({
      finish: 20_000,
      ready: 20_000,
      request: 1_000,
      stop: 8_000,
      kill: 3_000,
    });
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

  // Break caught (run 5, Stage 1.6): a failure of "not ready within 20000 ms" that does not say which of the two things that can be slow was: a process that is still starting
  // (it is CPU-bound until it listens, and a loaded machine is slow at it) or one that listens and whose /readyz is not 200 (its database, its seed). The bound is the same
  // 20 seconds for both, counted from the spawn; what changes is what the failure says: when it was first listening, and the last answer of /readyz, status and body.
  it('say, when a process listens and /readyz is not 200, when it was listening and what /readyz last said', async () => {
    const port = await freePort();
    const server = createHttpServer((request, response) => {
      response.statusCode = request.url === '/readyz' ? 503 : 200;
      response.end(
        request.url === '/readyz'
          ? '{"status":"unavailable","reason":"reference_data_missing"}'
          : '{}',
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const running = start(script(FOREVER), {});

    const failure = await running
      .waitUntilReady(`http://127.0.0.1:${String(port)}`, 700)
      .catch((error: unknown) => error as Error);

    const message = (failure as Error).message;
    expect(message).toContain('was not ready within 700 ms');
    expect(message).toMatch(/it was listening after \d+ ms/);
    expect(message).toContain('the last answer of /readyz was 503');
    expect(message).toContain('reference_data_missing');
  });

  // Break caught: a process that never listens (it is still compiling its contract, or its port is wrong) reported as one whose readiness failed, which sends the
  // investigation to the database.
  it('say that a process was not listening when nothing answered on its port', async () => {
    const port = await freePort();
    const running = start(script(FOREVER), {});

    const failure = await running
      .waitUntilReady(`http://127.0.0.1:${String(port)}`, 700)
      .catch((error: unknown) => error as Error);

    const message = (failure as Error).message;
    expect(message).toContain('was not ready within 700 ms');
    expect(message).toContain('it was not listening: nothing answered on the port');
    expect(message).not.toContain('the last answer of /readyz');
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

  // Break caught (the hosted unit job of 12 November 2026: the API's SIGTERM test failed in about one run in eight, on main's code as well as on a branch that does not touch the API): a test that sends a
  // signal and then asks the process something in the same breath races two processes, and the answer can be the one from before the signal was taken. A process says what has happened by what it
  // writes, and a test that must not act before then waits for that.
  it('wait until the process has written what the test is waiting for', async () => {
    const running = start(
      script(
        'setTimeout(() => console.log("shutdown started"), 150); setInterval(() => {}, 1000);',
      ),
      {},
    );

    await running.waitForOutput(
      (output) => output.includes('shutdown started'),
      3_000,
      'the process did not say it had stopped',
    );

    expect(running.stdout).toContain('shutdown started');
  });

  it('say what it waited for, with what the process wrote, when the process never writes it', async () => {
    const running = start(script(FOREVER), {});

    const failure = await running
      .waitForOutput(
        (output) => output.includes('never written'),
        400,
        'the process did not say it had stopped',
      )
      .catch((error: unknown) => error as Error);

    const message = (failure as Error).message;
    expect(message).toContain('the process did not say it had stopped within 400 ms');
    expect(message).toMatch(/after \d+ ms/);
    expect(message).toContain('started');
    expect(message).toContain('noise');
  });

  it('say that the process ended first, with what it wrote, instead of waiting out the deadline', async () => {
    const running = start(script('console.log("last words"); process.exit(5);'), {});
    const began = Date.now();

    const failure = await running
      .waitForOutput(
        (output) => output.includes('never written'),
        10_000,
        'the process did not say it had stopped',
      )
      .catch((error: unknown) => error as Error);

    const message = (failure as Error).message;
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(message).toContain('the process did not say it had stopped');
    expect(message).toContain('exited first');
    expect(message).toContain('code 5');
    expect(message).toContain('last words');
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

describe('apiSettings', () => {
  // Break caught: a process test about something else having to repeat sixteen settings, or the API failing to start in it.
  it('gives the API the settings a test did not name, and never one a test named', () => {
    const named = { NODE_ENV: 'production', APP_ENV: 'local', HTTP_PORT: '1', DATABASE_URL: 'x' };
    const given = apiSettings(MAIN, { ...named, OPS_ORIGIN: 'http://127.0.0.1:9' });

    expect(given).toMatchObject({ ...named, OPS_ORIGIN: 'http://127.0.0.1:9' });
    expect(Object.keys(given)).toEqual(
      expect.arrayContaining(['VENDOR_ORIGIN', 'KEY_CUSTODY', 'KEY_TOTP_SEED_MATERIAL']),
    );
    expect(Object.keys(given).filter((name) => name.startsWith('KEY_'))).toHaveLength(11);
  });

  // Break caught: a test that means to leave APP_ENV out being given one, so "missing" could never be proved.
  it('does not supply the four settings tests name for themselves', () => {
    for (const name of ['NODE_ENV', 'APP_ENV', 'HTTP_PORT', 'DATABASE_URL']) {
      expect(apiSettings(MAIN, {})).not.toHaveProperty(name);
    }
  });

  // Break caught: key material put into the environment of a database tool, which has no use for it.
  it('adds nothing for a script that is not the API', () => {
    expect(apiSettings('db-migrate.js', { DATABASE_MIGRATION_URL: 'x' })).toEqual({
      DATABASE_MIGRATION_URL: 'x',
    });
  });

  it('gives each call fresh key material', () => {
    expect(apiSettings(MAIN, {}).KEY_TOTP_SEED_MATERIAL).not.toBe(
      apiSettings(MAIN, {}).KEY_TOTP_SEED_MATERIAL,
    );
  });
});
