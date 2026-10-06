import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DEADLINES,
  freePort,
  killAll,
  MAIN,
  OPENAPI_COMMAND,
  requireBuild,
  run,
  start,
  UNREACHABLE_DATABASE_URL,
  type RunningProcess,
} from './support/api-process.js';

beforeAll(requireBuild);

const scratch: string[] = [];

// Every process the helpers started is killed here, with SIGKILL, whether or not the test got as far as
// stopping it: a failed or timed-out test must not leave an API running behind it.
afterEach(async () => {
  await killAll();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function launch(env: Record<string, string>): RunningProcess {
  return start(MAIN, env);
}

/** A request with a deadline of its own, so a server that never answers cannot hold a test. */
const bounded = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(DEADLINES.request) });

function records(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const nothingListening = (port: number) => bounded(`http://127.0.0.1:${String(port)}/livez`);

describe('startup refusals', () => {
  // Break caught: a missing required key silently defaulted, so the API boots in a mode nobody chose.
  it('refuses to start without a required key, names it, and listens on nothing', async () => {
    const port = await freePort();
    const result = await run(MAIN, {
      NODE_ENV: 'production',
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
    });

    expect(result.code).toBe(1);
    const [fatal] = records(result.stderr);
    expect(fatal).toMatchObject({
      level: 'fatal',
      problems: [{ key: 'APP_ENV', problem: 'missing' }],
    });
    await expect(nothingListening(port)).rejects.toThrow();
  });

  // Break caught: the API starting with no database configured, which would defer the failure to the first
  // request that needs one and make a missing setting look like an outage.
  it('refuses to start without a database URL, names it, and listens on nothing', async () => {
    const port = await freePort();
    const result = await run(MAIN, {
      NODE_ENV: 'production',
      APP_ENV: 'local',
      HTTP_PORT: String(port),
    });

    expect(result.code).toBe(1);
    expect(records(result.stderr)[0]).toMatchObject({
      level: 'fatal',
      problems: [{ key: 'DATABASE_URL', problem: 'missing' }],
    });
    await expect(nothingListening(port)).rejects.toThrow();
  });

  // Break caught: the API accepting a URL for the owner or the migration identity, which would give a
  // running request handler the power to change the schema or to bypass row-level security. Neither
  // password may be written out in the refusal.
  it.each([
    [
      'the owner role',
      'postgres://melarc_owner:OWNER-SECRET-PW@127.0.0.1:1/melarc',
      'OWNER-SECRET-PW',
    ],
    [
      'the migration role',
      'postgres://melarc_migration_elevated:MIGRATION-SECRET-PW@127.0.0.1:1/melarc',
      'MIGRATION-SECRET-PW',
    ],
    // Audit F01: the authority names the runtime role and the query string renames it.
    [
      'the runtime role with a query string that renames the user',
      'postgres://melarc_api_runtime:RUNTIME-SECRET-PW@127.0.0.1:1/melarc?user=postgres',
      'RUNTIME-SECRET-PW',
    ],
    [
      'the runtime role with a TLS option',
      'postgres://melarc_api_runtime:RUNTIME-SECRET-PW@127.0.0.1:1/melarc?sslmode=require',
      'RUNTIME-SECRET-PW',
    ],
  ])(
    'refuses a database URL for %s and never writes its password',
    async (_role, url, password) => {
      const port = await freePort();
      const result = await run(MAIN, {
        NODE_ENV: 'production',
        APP_ENV: 'local',
        HTTP_PORT: String(port),
        DATABASE_URL: url,
      });

      expect(result.code).toBe(1);
      expect(records(result.stderr)[0]).toMatchObject({
        problems: [{ key: 'DATABASE_URL', problem: 'invalid' }],
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(password);
      await expect(nothingListening(port)).rejects.toThrow();
    },
  );

  // Break caught: migration credentials being accepted in the API environment, where a compromised
  // process could read and use them. Their presence alone is a refusal, and the password is not echoed.
  it('refuses to start when migration credentials are in its environment', async () => {
    const port = await freePort();
    const result = await run(MAIN, {
      NODE_ENV: 'production',
      APP_ENV: 'local',
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      DATABASE_MIGRATION_URL:
        'postgres://melarc_migration_elevated:MIGRATION-SECRET-PW@127.0.0.1:1/melarc',
    });

    expect(result.code).toBe(1);
    expect(records(result.stderr)[0]).toMatchObject({
      problems: [{ key: 'DATABASE_MIGRATION_URL', problem: 'invalid' }],
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain('MIGRATION-SECRET-PW');
    await expect(nothingListening(port)).rejects.toThrow();
  });

  // Break caught: staging or production allowed to run in a development mode
  // (DEPLOYMENT_AND_ENVIRONMENTS.md §12.3: production permits no development bypass).
  it('refuses to start production configured in development mode', async () => {
    const port = await freePort();
    const result = await run(MAIN, {
      NODE_ENV: 'development',
      APP_ENV: 'production',
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
    });

    expect(result.code).toBe(1);
    expect(records(result.stderr)[0]).toMatchObject({
      problems: [{ key: 'NODE_ENV', problem: 'invalid' }],
    });
    await expect(nothingListening(port)).rejects.toThrow();
  });

  // Break caught: the refusal echoing what was supplied, which leaks a secret pasted in the wrong variable.
  it('never writes a rejected value', async () => {
    const result = await run(MAIN, {
      NODE_ENV: 'hunter2-secret',
      APP_ENV: 's3cr3t-environment',
      HTTP_PORT: 'sk_live_not_a_port',
      DATABASE_URL: 'postgres://wrong_role:db-secret-pw@127.0.0.1:1/melarc',
    });

    expect(result.code).toBe(1);
    const everything = `${result.stdout}${result.stderr}`;
    for (const secret of [
      'hunter2-secret',
      's3cr3t-environment',
      'sk_live_not_a_port',
      'db-secret-pw',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  // Break caught: a failure after configuration was accepted (here, a port already in use) hanging or
  // crashing with Node's raw output instead of one fatal line and a non-zero exit.
  it('exits non-zero with one fatal line when the port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
    const { port } = blocker.address() as { port: number };
    try {
      const result = await run(MAIN, {
        NODE_ENV: 'production',
        APP_ENV: 'local',
        HTTP_PORT: String(port),
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
      });

      expect(result.code).toBe(1);
      expect(records(result.stderr)[0]).toMatchObject({ level: 'fatal', msg: 'startup failed' });
    } finally {
      await new Promise((resolveClose) => blocker.close(resolveClose));
    }
  });
});

describe('a running API process', () => {
  // Break caught: a process that does not boot, serves nothing, writes anything but structured lines,
  // or logs a secret from its environment or from the requests it handles.
  it('boots, serves its probes, writes only JSON, and logs no secret', async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const running = launch({
      NODE_ENV: 'production',
      APP_ENV: 'local',
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      SESSION_SECRET: 'ENV-SECRET-TWO',
    });
    await running.waitUntilLive(baseUrl);

    expect((await bounded(`${baseUrl}/livez`)).status).toBe(200);
    // The database is absent, so the API is live and not ready, and says why without naming anything.
    const readiness = await bounded(`${baseUrl}/readyz`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: 'not_ready',
      reason: 'dependency_unavailable',
    });
    await (
      await bounded(`${baseUrl}/api/v1/nothing-here?token=QUERY-SECRET`, {
        headers: { Authorization: 'Bearer REQUEST-SECRET', Cookie: 'melarc_session=COOKIE-SECRET' },
      })
    ).text();
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));

    const output = `${running.stdout}${running.stderr}`;
    const lines = records(running.stdout);
    // Every key must appear once: a duplicate key is ambiguous JSON that tools resolve differently.
    const listeningLine = running.stdout.split('\n').find((line) => line.includes('api listening'));
    expect((listeningLine?.match(/"env":/g) ?? []).length).toBe(1);
    expect(lines.find((record) => record.msg === 'api listening')).toMatchObject({
      port,
      env: 'local',
    });
    for (const secret of [
      'ENV-SECRET-ONE',
      'ENV-SECRET-TWO',
      'QUERY-SECRET',
      'REQUEST-SECRET',
      'COOKIE-SECRET',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(running.stderr).toBe('');
  });

  // Break caught: a signal that does not drain, does not close, or does not end the process with 0.
  // Windows cannot deliver a graceful SIGTERM to a child process, so this runs on Linux and macOS (and CI).
  it.skipIf(process.platform === 'win32')(
    'shuts down on SIGTERM: not ready at once, then a clean exit',
    async () => {
      const port = await freePort();
      const baseUrl = `http://127.0.0.1:${String(port)}`;
      const running = launch({
        NODE_ENV: 'production',
        APP_ENV: 'local',
        HTTP_PORT: String(port),
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        SHUTDOWN_TIMEOUT_MS: '5000',
        SHUTDOWN_DRAIN_DELAY_MS: '1500',
      });
      await running.waitUntilLive(baseUrl);

      running.signal('SIGTERM');
      const draining = await bounded(`${baseUrl}/readyz`);
      // The database is absent in this test, so a bare 503 is also what an API that never drained would
      // return. The reason is what proves the drain.
      const drainingBody: unknown = await draining.json();
      // Graceful verification: the process must end by itself. If it does not, it is killed and this fails
      // saying so, instead of passing off a killed process as one that shut down.
      const finished = await running.waitForExit(
        DEADLINES.stop,
        `did not exit within ${String(DEADLINES.stop)} ms of SIGTERM`,
      );

      expect(draining.status).toBe(503);
      expect(drainingBody).toEqual({ status: 'not_ready', reason: 'shutting_down' });
      expect(finished.code).toBe(0);
      expect(records(finished.stdout).map((record) => record.msg)).toEqual(
        expect.arrayContaining(['signal received', 'shutdown started', 'shutdown complete']),
      );
      await expect(nothingListening(port)).rejects.toThrow();
    },
  );
});

describe('the OpenAPI generation command', () => {
  // Break caught: output that is not derived from the application (for instance a copy of the contract),
  // or a command that needs a database or a configured environment just to describe itself.
  it('writes a description and a route inventory derived from the application', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'melarc-generate-'));
    scratch.push(outDir);

    const result = await run(OPENAPI_COMMAND, {}, [outDir]);

    expect(result.code).toBe(0);
    const document = JSON.parse(readFileSync(join(outDir, 'openapi.generated.json'), 'utf8')) as {
      info: { title: string };
      paths: Record<string, unknown>;
    };
    const inventory = JSON.parse(
      readFileSync(join(outDir, 'route-inventory.generated.json'), 'utf8'),
    ) as { live: { method: string; path: string }[] };

    expect(document.info.title).toContain('derived from the implementation');
    expect(document.paths).toEqual({});
    expect(inventory.live).toEqual([
      { method: 'GET', path: '/livez' },
      { method: 'GET', path: '/readyz' },
    ]);
    expect(existsSync(join(outDir, 'openapi.generated.json'))).toBe(true);
  });
});
