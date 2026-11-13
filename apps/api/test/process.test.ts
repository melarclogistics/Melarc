import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { deployedEnv, randomKey, validEnv } from '../src/test-support/config-env.js';
import {
  DEADLINES,
  freePort,
  killAll,
  MAIN,
  OPENAPI_COMMAND,
  requireBuild,
  run,
  start,
  startCommand,
  UNREACHABLE_DATABASE_URL,
  type RunningProcess,
} from './support/api-process.js';
import { implementedOperations } from './support/contract-operations.js';

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

/** Whether a line of the process's output, written whole so far, is the log record with this message: the last line may still be arriving, and is not one yet. */
function logged(text: string, message: string): boolean {
  return text.split('\n').some((line) => {
    try {
      return (JSON.parse(line) as { msg?: unknown }).msg === message;
    } catch {
      return false;
    }
  });
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
      // https, as a deployment has, so that the only thing wrong is the mode.
      OPS_ORIGIN: 'https://ops.melarc.example',
      VENDOR_ORIGIN: 'https://vendor.melarc.example',
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

  // Break caught: a failed start that leaves the private metrics endpoint open. It is a handle of its own, so the process never ends, a
  // restart policy never fires, and a scraper sees the target up while no API listens.
  it('ends a failed start when the metrics endpoint is on, and leaves nothing listening on its port', async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
    const { port } = blocker.address() as { port: number };
    const metricsPort = await freePort();
    try {
      const result = await run(MAIN, {
        NODE_ENV: 'production',
        APP_ENV: 'local',
        HTTP_PORT: String(port),
        METRICS_PORT: String(metricsPort),
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
      });

      expect(result.code).toBe(1);
      expect(records(result.stderr).at(-1)).toMatchObject({
        level: 'fatal',
        msg: 'startup failed',
      });
      await expect(bounded(`http://127.0.0.1:${String(metricsPort)}/metrics`)).rejects.toThrow();
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
      // The signal and the request go from this process to another, and nothing orders them: a request made at once can be answered as the API was before it took the signal (the
      // hosted unit job of 12 November 2026 failed on that in about one run in eight, on main's code as well). The API says it has taken the signal and begun to drain by writing
      // "shutdown started", which it does after its state has become `draining`: the request is made then, and what it is answered is the API's, not the race's.
      await running.waitForOutput(
        (output) => logged(output, 'shutdown started'),
        DEADLINES.stop,
        'the API did not log "shutdown started" after SIGTERM',
      );
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
    // The operations of the implemented scope are the routes of the product, and nothing else is described or served but the two probes. The
    // expectation is read from the contract and the scope as they are (`test/support/contract-operations.ts`), not typed here: a list typed
    // here was true on the day of S0.60 and untrue at the first operation after it.
    const operations = implementedOperations();
    expect(Object.keys(document.paths).toSorted()).toEqual(
      [...new Set(operations.map((operation) => operation.path))].toSorted(),
    );
    expect(inventory.live).toEqual(
      [
        ...operations.map((operation) => ({
          method: operation.method,
          path: `/api/v1${operation.path.replaceAll(/\{(\w+)\}/g, ':$1')}`,
        })),
        { method: 'GET', path: '/livez' },
        { method: 'GET', path: '/readyz' },
      ].toSorted(
        (left, right) =>
          left.method.localeCompare(right.method) ||
          (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
      ),
    );
    expect(existsSync(join(outDir, 'openapi.generated.json'))).toBe(true);
  });
});

describe('startup refusals for the settings S0.2 adds', () => {
  /** A deployment that sets every real adapter and still has no production key custody to name. */
  const productionEnv = (port: number, overrides: Record<string, string | undefined> = {}) =>
    deployedEnv('production', {
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      DELIVERY_EMAIL_ADAPTER: 'provider',
      DELIVERY_EMAIL_ENDPOINT: 'https://email.provider.example/v1',
      DELIVERY_EMAIL_TIMEOUT_MS: '5000',
      DELIVERY_SMS_ADAPTER: 'provider',
      DELIVERY_SMS_ENDPOINT: 'https://sms.provider.example/v1',
      DELIVERY_SMS_TIMEOUT_MS: '5000',
      ATTESTATION_VERIFIER: 'service',
      ATTESTATION_VERIFIER_URL: 'https://verifier.internal.example',
      ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
      ATTESTATION_VERIFIER_CALLER_SECRET: randomKey(),
      // The evidence store of a deployment is the real one: the in-process stand-in is refused in production (S1.11), and the bucket's four settings go with the real one. The scanner
      // is left unset on purpose: a production without one starts and stores nothing (EVIDENCE_SCANNER in config-settings.ts), so it is no refusal of the start.
      EVIDENCE_STORE: 'r2',
      EVIDENCE_R2_ACCOUNT_ID: 'testaccount',
      EVIDENCE_R2_BUCKET: 'test-evidence',
      EVIDENCE_R2_ACCESS_KEY_ID: 'TESTONLYACCESSKEY',
      EVIDENCE_R2_SECRET_ACCESS_KEY: randomKey(),
      ...overrides,
    });

  const secretsIn = (env: Record<string, string>): string[] =>
    Object.entries(env)
      .filter(([name]) => /_MATERIAL$|CALLER_SECRET$|SECRET_ACCESS_KEY$/.test(name))
      .flatMap(([, value]) => value.split(',').map((entry) => entry.slice(entry.indexOf(':') + 1)));

  // The proof of DEPLOYMENT_AND_ENVIRONMENTS.md section 12.3 that matters: the real binary, in production, with everything else
  // real, refuses the local key substitute, exits 1, listens on nothing and prints no key.
  it('refuses to start in production on the local key custody, and says so without a key', async () => {
    const port = await freePort();
    const env = productionEnv(port);
    const result = await run(MAIN, env);

    expect(result.code).toBe(1);
    expect(records(result.stderr)[0]).toMatchObject({
      level: 'fatal',
      problems: [{ key: 'KEY_CUSTODY', problem: 'invalid' }],
    });
    await expect(nothingListening(port)).rejects.toThrow();
    // The five keys, the verifier's caller secret and the bucket's secret access key: none of them is printed by the refusal.
    const secrets = secretsIn(env);
    expect(secrets).toHaveLength(7);
    for (const secret of secrets) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    }
  });

  // Break caught: a production start that boots with a test adapter selected, which would run credential delivery or
  // attestation on a stand-in.
  it.each([
    [
      'the capture delivery adapter',
      {
        DELIVERY_SMS_ADAPTER: 'capture',
        DELIVERY_SMS_ENDPOINT: undefined,
        DELIVERY_SMS_TIMEOUT_MS: undefined,
      },
      'DELIVERY_SMS_ADAPTER',
    ],
    ['the in-memory limiter', { RATE_LIMITER: 'memory' }, 'RATE_LIMITER'],
  ])(
    'refuses to start in production with %s, beside the key custody',
    async (_label, change, key) => {
      const port = await freePort();
      const result = await run(MAIN, productionEnv(port, change));

      expect(result.code).toBe(1);
      const fatal = records(result.stderr)[0] as { problems: { key: string }[] };
      expect(fatal.problems.map((problem) => problem.key).toSorted()).toEqual(
        [key, 'KEY_CUSTODY'].toSorted(),
      );
      await expect(nothingListening(port)).rejects.toThrow();
    },
  );

  // Break caught: a production start with a key absent, which the design refuses rather than boots degraded.
  it('refuses to start with a key absent, names the setting, and listens on nothing', async () => {
    const port = await freePort();
    const env = validEnv({
      NODE_ENV: 'production',
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      KEY_PASSWORD_PEPPER_MATERIAL: undefined,
    });
    // startCommand adds nothing to the environment it is given, so the key really is absent.
    const result = await startCommand(process.execPath, [MAIN], env).waitForExit(
      DEADLINES.finish,
      `did not finish within ${String(DEADLINES.finish)} ms`,
    );

    expect(result.code).toBe(1);
    expect(records(result.stderr)[0]).toMatchObject({
      level: 'fatal',
      problems: [{ key: 'KEY_PASSWORD_PEPPER_MATERIAL', problem: 'missing' }],
    });
    await expect(nothingListening(port)).rejects.toThrow();
  });

  // Break caught: a key or a caller secret carried out by the one line the API writes when it is live, or by a request.
  it('starts with every setting and writes no key or caller secret anywhere', async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const env = validEnv({
      NODE_ENV: 'production',
      HTTP_PORT: String(port),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      ATTESTATION_VERIFIER: 'service',
      ATTESTATION_VERIFIER_URL: 'http://127.0.0.1:9100',
      ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
      ATTESTATION_VERIFIER_CALLER_SECRET: randomKey(),
      KEY_TOTP_SEED_MATERIAL: `1:${randomKey()},2:${randomKey()}`,
      KEY_TOTP_SEED_ACTIVE_VERSION: '2',
    });
    const running = startCommand(process.execPath, [MAIN], env);
    await running.waitUntilLive(baseUrl);
    expect((await bounded(`${baseUrl}/livez`)).status).toBe(200);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));

    const secrets = secretsIn(env);
    expect(secrets).toHaveLength(7);
    for (const secret of secrets) {
      expect(`${running.stdout}${running.stderr}`).not.toContain(secret);
    }
  });
});
